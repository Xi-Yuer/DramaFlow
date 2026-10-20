import { describe, expect, it } from 'vitest';
import { workflowExecutionJobId, isRetryableWorkflowInfrastructureError } from '../src/index.js';

describe('执行命令身份与基础设施错误分类', () => {
  it('同一领域意图稳定，不同恢复意图不同，身份不包含冒号或业务值', () => {
    const start = { kind: 'start' as const, workflowRunId: 'run:with/separators' };
    expect(workflowExecutionJobId(start)).toBe(workflowExecutionJobId(structuredClone(start)));
    expect(workflowExecutionJobId(start)).not.toContain(':');
    const first = {
      kind: 'resume' as const,
      workflowRunId: start.workflowRunId,
      executionId: 'intent-1',
      value: 'secret payload',
    };
    expect(workflowExecutionJobId(first)).toBe(
      workflowExecutionJobId({ ...first, value: 'other value' }),
    );
    expect(workflowExecutionJobId(first)).not.toBe(
      workflowExecutionJobId({ ...first, executionId: 'intent-2' }),
    );
    expect(workflowExecutionJobId(first)).not.toContain('secret');
  });
  it('只允许识别的基础设施错误自动重试，不根据任意业务文本重试', () => {
    for (const code of ['P1001', 'P2024', 'P2034', 'ECONNRESET'])
      expect(
        isRetryableWorkflowInfrastructureError(Object.assign(new Error('private'), { code })),
      ).toBe(true);
    for (const error of [
      new Error('ECONNRESET'),
      Object.assign(new Error('business'), { code: 'NODE_EXECUTION_FAILED' }),
      null,
      'P1001',
    ])
      expect(isRetryableWorkflowInfrastructureError(error)).toBe(false);
  });
});
