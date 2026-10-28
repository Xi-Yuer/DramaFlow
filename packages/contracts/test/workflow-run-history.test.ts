import { describe, expect, it } from 'vitest';
import {
  encodeWorkflowRunCursor,
  decodeWorkflowRunCursor,
  workflowRunHistoryQuerySchema,
  workflowRunSummarySchema,
} from '../src/index.js';

describe('Workflow Run History 协议', () => {
  it('游标保留毫秒和同时间 id 边界，拒绝畸形或额外身份', () => {
    const cursor = { createdAt: '2026-10-28T00:00:00.123Z', id: 'run-z' };
    expect(decodeWorkflowRunCursor(encodeWorkflowRunCursor(cursor))).toEqual(cursor);
    for (const value of [
      'A',
      '!',
      'x'.repeat(513),
      btoa(JSON.stringify({ ...cursor, createdAt: '2026-10-28T00:00:00.123456Z' })).replaceAll(
        '=',
        '',
      ),
    ])
      expect(() => decodeWorkflowRunCursor(value)).toThrow();
    expect(workflowRunHistoryQuerySchema.safeParse({ ownerId: 'injected' }).success).toBe(false);
  });
  it('公开摘要不接受内部字段、输入输出或额外执行身份', () => {
    const row = {
      id: 'run',
      workflowId: 'workflow',
      workflowVersionId: 'old-version',
      version: 1,
      status: 'completed',
      createdAt: '2026-10-28T00:00:00.000Z',
    };
    expect(workflowRunSummarySchema.parse(row)).toEqual(row);
    for (const field of ['threadId', 'checkpoint', 'jobId', 'executionId', 'inputs', 'outputs'])
      expect(workflowRunSummarySchema.safeParse({ ...row, [field]: 'private' }).success).toBe(
        false,
      );
  });
});
