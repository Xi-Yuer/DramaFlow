import { AnyType, NumberType, StringType, type RuntimeValue } from '@dramaflow/contracts';
import { describe, expect, it } from 'vitest';
import { isWorkflowInvocationEquivalent } from '../../src/index.js';
import { workflowRunnerFixture } from '../fixtures/workflow-runner-fixture.js';

const inline = (value: Extract<RuntimeValue, { storage: 'inline' }>['value']): RuntimeValue => ({
  storage: 'inline',
  type: AnyType,
  value,
});

describe('公共 Workflow Start invocation 幂等', () => {
  it.each(['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'] as const)(
    '同 key 等价调用复用 %s Run，不创建第二次记录或执行 Graph',
    async (status) => {
      const f = workflowRunnerFixture();
      const initial = await f.submission.start(f.input);
      f.submissionRepository.createWithExecution.mockResolvedValue({
        run: { ...initial, status },
        created: false,
      });
      const repeated = await f.submission.start(f.input);
      expect(repeated).toEqual({ ...initial, status });
      expect(f.runs.create).toHaveBeenCalledTimes(1);
      expect(f.compile).not.toHaveBeenCalled();
    },
  );

  it('同 key 的不同合法版本产生领域冲突', async () => {
    const f = workflowRunnerFixture();
    const original = await f.submission.start(f.input);
    f.getVersion.mockResolvedValue({ ...f.version, id: 'version-other' });
    await expect(
      f.submission.start({ ...f.input, workflowVersionId: 'version-other' }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_INVOCATION_CONFLICT', workflowRunId: original.id });
    expect(f.runs.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['inline 值', { a: inline(1) }, { a: inline(2) }],
    ['数组顺序', { a: inline([1, 2]) }, { a: inline([2, 1]) }],
    ['missing / null', {}, { a: inline(null) }],
    [
      'RuntimeValue.type',
      { a: { storage: 'inline', type: NumberType, value: 1 } },
      { a: { storage: 'inline', type: AnyType, value: 1 } },
    ],
    [
      'reference 描述',
      { a: { storage: 'reference', type: StringType, reference: { kind: 'artifact', id: 'a' } } },
      { a: { storage: 'reference', type: StringType, reference: { kind: 'artifact', id: 'b' } } },
    ],
  ] satisfies [string, Record<string, RuntimeValue>, Record<string, RuntimeValue>][])(
    '%s 不同产生领域冲突',
    async (_label, first, second) => {
      const f = workflowRunnerFixture();
      f.version.definition.inputs = [{ name: 'a', type: AnyType, required: false }];
      const original = await f.submission.start({ ...f.input, inputs: first });
      await expect(f.submission.start({ ...f.input, inputs: second })).rejects.toMatchObject({
        code: 'WORKFLOW_INVOCATION_CONFLICT',
        workflowRunId: original.id,
      });
      expect(f.runs.create).toHaveBeenCalledTimes(1);
    },
  );

  it('递归对象属性顺序不影响调用等价，数组内对象亦如此', async () => {
    const f = workflowRunnerFixture();
    f.version.definition.inputs = [{ name: 'a', type: AnyType, required: true }];
    const a = { ...f.input, inputs: { a: inline({ x: 1, nested: [{ a: 2, b: 3 }] }) } };
    const b = { ...f.input, inputs: { a: inline({ nested: [{ b: 3, a: 2 }], x: 1 }) } };
    expect(await f.submission.start(b)).toEqual(await f.submission.start(a));
    expect(f.runs.create).toHaveBeenCalledTimes(1);
  });

  it('领域比较包含 Workflow 身份', () => {
    const request = { workflowId: 'a', workflowVersionId: 'v', inputs: {} };
    expect(isWorkflowInvocationEquivalent(request, { ...request, workflowId: 'b' })).toBe(false);
  });
});
