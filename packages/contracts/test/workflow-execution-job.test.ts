import { describe, expect, it } from 'vitest';
import { workflowExecutionJobSchema, type WorkflowExecutionJob } from '../src/index.js';

describe('Workflow execution job 契约', () => {
  it('start 只传业务运行 ID；拒绝 State、Definition、thread 和版本副本', () => {
    const job: WorkflowExecutionJob = { kind: 'start', workflowRunId: 'run-1' };
    expect(workflowExecutionJobSchema.parse(job)).toEqual(job);
    for (const key of [
      'workflowDefinition',
      'workflowState',
      'threadId',
      'workflowVersionId',
      'projectId',
    ])
      expect(workflowExecutionJobSchema.safeParse({ ...job, [key]: {} }).success).toBe(false);
  });

  it('resume 保持 unknown，接受 falsy 值并要求显式提供 value', () => {
    for (const value of [false, 0, '', null, { approved: true }]) {
      const job: WorkflowExecutionJob = { kind: 'resume', workflowRunId: 'run-1', value };
      expect(workflowExecutionJobSchema.parse(job)).toEqual(job);
    }
    expect(
      workflowExecutionJobSchema.safeParse({ kind: 'resume', workflowRunId: 'run-1' }).success,
    ).toBe(false);
    expect(
      workflowExecutionJobSchema.safeParse({ kind: 'start', workflowRunId: 'run-1', value: 1 })
        .success,
    ).toBe(false);
  });
});
