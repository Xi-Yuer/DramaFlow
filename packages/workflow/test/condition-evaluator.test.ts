import { describe, expect, it, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { LogicEngine } from 'json-logic-engine';
import { evaluateCondition } from '../src/compiler/if/condition-evaluator.js';

const variable = { var: 'value' };
const equals = { '===': [variable, 'approved'] };
afterEach(() => vi.restoreAllMocks());
describe('Condition evaluator 安全边界', () => {
  it.each([
    [equals, 'approved', true],
    [equals, 'Approved', false],
    [equals, 'approved ', false],
    [{ '!==': [variable, 'approved'] }, 'denied', true],
    [{ '!==': [variable, 'approved'] }, 'approved', false],
    [{ in: ['prov', variable] }, 'approved', true],
    [{ in: ['PROV', variable] }, 'approved', false],
    [{ '!': { in: ['denied', variable] } }, 'approved', true],
    [{ '!': { in: ['prov', variable] } }, 'approved', false],
    [{ '===': [variable, ''] }, '', true],
    [{ in: ['', variable] }, '', false],
  ] as const)('按原始 string 判断 %j / %j → %s', (condition, value, expected) => {
    expect(evaluateCondition(condition, { value })).toBe(expected);
  });
  it.each([
    undefined,
    null,
    {},
    { value: undefined },
    { value: null },
    { value: 0 },
    { value: false },
    { value: [] },
    { value: {} },
    { value: 'x', state: {} },
    { value: 'x', credential: 'marker' },
  ])('missing/type/多余上下文一律在引擎前拒绝', (values) => {
    const run = vi.spyOn(LogicEngine.prototype, 'run');
    expect(() => evaluateCondition(equals, values)).toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it('不接受继承的 value 或 getter，不执行用户函数', () => {
    const getter = vi.fn(() => 'approved');
    for (const values of [
      Object.create({ value: 'approved' }),
      Object.defineProperty({}, 'value', { get: getter, enumerable: true }),
    ]) {
      expect(() => evaluateCondition(equals, values)).toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    { '!==': [{ var: 'missing' }, 'x'] },
    { '>': [variable, 0] },
    { var: 'value' },
    { '===': [variable, 'x'], extra: true },
  ])('非法表达式不能到达 Engine', (expression) => {
    const run = vi.spyOn(LogicEngine.prototype, 'run');
    expect(() => evaluateCondition(expression, { value: 'x' })).toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 0, 1, '', 'false', [], {}].map((result) => ({ result })))(
    '第三方返回非 boolean 时拒绝，不转换 truthiness',
    ({ result }) => {
      vi.spyOn(LogicEngine.prototype, 'run').mockReturnValue(result);
      expect(() => evaluateCondition(equals, { value: 'approved' })).toThrow(
        expect.objectContaining({ code: 'CONDITION_RESULT_INVALID' }),
      );
    },
  );
  it('引擎失败使用安全错误，不附原异常、表达式或输入', () => {
    vi.spyOn(LogicEngine.prototype, 'run').mockImplementation(() => {
      throw new Error('upstream-sensitive-marker');
    });
    try {
      evaluateCondition(equals, { value: 'input-sensitive-marker' });
      throw new Error('should reject');
    } catch (error) {
      expect(error).toMatchObject({ code: 'CONDITION_EVALUATION_FAILED' });
      expect(String(error)).not.toMatch(/upstream-sensitive-marker|input-sensitive-marker/);
      expect(error).not.toHaveProperty('cause');
    }
  });
  it('真实生产 evaluator 在 Node 禁止 eval / Function 的进程内解释执行所有运算', () => {
    const url = new URL('../src/compiler/if/condition-evaluator.ts', import.meta.url).href;
    const program = `import assert from 'node:assert/strict';
      const { evaluateCondition } = await import(${JSON.stringify(url)});
      for (const expression of [
        {'===':[{var:'value'},'x']}, {'!==':[{var:'value'},'y']},
        {in:['x',{var:'value'}]}, {'!':{in:['y',{var:'value'}]}}
      ]) assert.equal(evaluateCondition(expression, {value:'x'}), true);
    `;
    expect(() =>
      execFileSync(
        process.execPath,
        ['--disallow-code-generation-from-strings', '--input-type=module', '-e', program],
        { stdio: 'pipe' },
      ),
    ).not.toThrow();
  });
});
