import { describe, expect, it, vi } from 'vitest';
import {
  conditionExpressionSchema,
  CONDITION_EXPRESSION_MAX_DEPTH,
  CONDITION_EXPRESSION_MAX_NODES,
  configFieldDefinitionSchema,
} from '../src/index.js';

const variable = { var: 'value' };
describe('string ConditionExpression 安全子集', () => {
  it.each([
    { '===': [variable, 'approved'] },
    { '!==': [variable, 'approved'] },
    { in: ['app', variable] },
    { '!': { in: ['app', variable] } },
    { '===': [variable, ''] },
  ])('合法表达式可无损 JSON 序列化 %j', (expression) => {
    const parsed = conditionExpressionSchema.parse(expression);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(expression);
  });
  it.each([
    'state',
    'credential',
    'foo.bar',
    'value.length',
    'constructor',
    '__proto__',
    '../value',
  ])('拒绝变量 %s', (name) => {
    expect(conditionExpressionSchema.safeParse({ '===': [{ var: name }, 'x'] }).success).toBe(
      false,
    );
  });
  it.each(
    [
      null,
      true,
      'true',
      1,
      [],
      {},
      { var: 'value' },
      { '==': [variable, 'x'] },
      { '>': [variable, 1] },
      { and: [{ '===': [variable, 'x'] }] },
      { or: [true, false] },
      { map: [] },
      { filter: [] },
      { reduce: [] },
      { '+': [1, 2] },
      { startsWith: [variable, 'x'] },
      { custom: [] },
      { '===': [variable, 1] },
      { '===': [variable, null] },
      { '===': [variable, false] },
      { '===': [variable, variable] },
      { '===': ['x', variable] },
      { in: [variable, 'abc'] },
      { in: ['x', ['x']] },
      { '!': { '===': [variable, 'x'] } },
      { '===': [{ var: ['value', 'fallback'] }, 'x'] },
      { '===': [{ var: 'value', extra: true }, 'x'] },
      { '===': [variable, 'x'], extra: true },
    ].map((expression) => ({ expression })),
  )('拒绝非 string 单条件或未知字段 $expression', ({ expression }) => {
    expect(conditionExpressionSchema.safeParse(expression).success).toBe(false);
  });
  it('在进入结构解析前拒绝过深、过大和循环对象', () => {
    let deep: unknown = { in: ['x', variable] };
    for (let index = 0; index < CONDITION_EXPRESSION_MAX_DEPTH + 2; index++) deep = { '!': deep };
    expect(conditionExpressionSchema.safeParse(deep).error?.issues[0]?.message).toContain('深度');
    const large = {
      '===': Array.from({ length: CONDITION_EXPRESSION_MAX_NODES + 1 }, () => variable),
    };
    expect(conditionExpressionSchema.safeParse(large).error?.issues[0]?.message).toContain('节点');
    const cyclic: Record<string, unknown> = {};
    cyclic['!'] = cyclic;
    expect(conditionExpressionSchema.safeParse(cyclic).success).toBe(false);
  });
  it.each([undefined, NaN, Infinity, 1n, () => 'x', Symbol('x'), new Date(), new Map()])(
    '非 JSON 数据不能进入表达式',
    (value) => {
      expect(conditionExpressionSchema.safeParse({ '===': [variable, value] }).success).toBe(false);
    },
  );
  it('拒绝 accessor、symbol、隐藏属性、稀疏数组与自定义原型，不执行 getter/toJSON', () => {
    const getter = vi.fn(() => 'x');
    const expression = Object.defineProperty({}, '===', { get: getter, enumerable: true });
    expect(conditionExpressionSchema.safeParse(expression).success).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    const toJSON = vi.fn(() => ({ '===': [variable, 'x'] }));
    const candidates = [
      { '===': [variable, 'x'], [Symbol('secret')]: 'x' },
      Object.defineProperty({ '===': [variable, 'x'] }, 'hidden', { value: 'x' }),
      { '===': Array(2) },
      Object.assign(Object.create({ inherited: true }), { '===': [variable, 'x'] }),
      { toJSON },
    ];
    for (const candidate of candidates)
      expect(conditionExpressionSchema.safeParse(candidate).success).toBe(false);
    expect(toJSON).not.toHaveBeenCalled();
  });
  it('Manifest 只增加 condition 字段类型，不开放通用对象表单或默认表达式', () => {
    expect(
      configFieldDefinitionSchema.parse({
        key: 'condition',
        name: '条件',
        type: 'condition',
        required: true,
      }),
    ).toEqual({ key: 'condition', name: '条件', type: 'condition', required: true });
    expect(
      configFieldDefinitionSchema.safeParse({
        key: 'condition',
        name: '条件',
        type: 'condition',
        defaultValue: { '===': [variable, 'x'] },
      }).success,
    ).toBe(false);
  });
});
