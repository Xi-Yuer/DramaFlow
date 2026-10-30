import { describe, expect, it } from 'vitest';
import {
  productWorkflowInvocationSchema,
  productWorkflowInvocationResponseSchema,
  startProductWorkflowInvocationSchema,
  encodeProductInvocationCursor,
  decodeProductInvocationCursor,
} from '../src/product/workflow-invocation.js';

const record = {
  id: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  sourceVideoId: '00000000-0000-4000-8000-000000000003',
  sourceVideoName: '受理时的作品名',
  workflowRunId: 'run-1',
  invocationKey: 'key-1',
  createdAt: '2026-10-30T00:00:00.000Z',
};
describe('产品 Workflow Invocation Contract', () => {
  it('响应中的调用必须指向同一 Run 和 invocationKey', () => {
    const run = {
      id: record.workflowRunId,
      workflowId: 'workflow-1',
      workflowVersionId: 'version-1',
      invocationKey: record.invocationKey,
      status: 'pending',
      inputs: {},
      createdAt: record.createdAt,
    };
    expect(productWorkflowInvocationResponseSchema.parse({ invocation: record, run })).toEqual({
      invocation: record,
      run,
    });
    for (const mismatch of [
      { ...run, id: 'other' },
      { ...run, invocationKey: 'other' },
    ])
      expect(
        productWorkflowInvocationResponseSchema.safeParse({ invocation: record, run: mismatch })
          .success,
      ).toBe(false);
  });
  it('只保存稳定来源身份，拒绝复制运行事实或追加产品内容', () => {
    expect(productWorkflowInvocationSchema.parse(record)).toEqual(record);
    for (const key of ['status', 'inputs', 'outputs', 'error', 'script', 'workflowVersionId'])
      expect(productWorkflowInvocationSchema.safeParse({ ...record, [key]: 'extra' }).success).toBe(
        false,
      );
  });
  it('复用正式运行请求，必须显式提供版本和 key，不能由客户端声明来源', () => {
    const request = { workflowVersionId: 'version-1', invocationKey: 'key-1', inputs: {} };
    expect(startProductWorkflowInvocationSchema.parse(request)).toEqual(request);
    for (const invalid of [
      { ...request, invocationKey: '' },
      { ...request, workflowVersionId: '' },
      { ...request, videoId: record.sourceVideoId },
      { ...request, inputs: { prompt: '未包装的值' } },
    ])
      expect(startProductWorkflowInvocationSchema.safeParse(invalid).success).toBe(false);
  });
  it('分页游标稳定往返且拒绝损坏和非法身份', () => {
    const cursor = { id: record.id, createdAt: record.createdAt };
    expect(decodeProductInvocationCursor(encodeProductInvocationCursor(cursor))).toEqual(cursor);
    for (const value of [
      'invalid',
      '%%%',
      btoa('{}'),
      btoa(JSON.stringify({ ...cursor, id: 'bad' })),
    ])
      expect(() => decodeProductInvocationCursor(value)).toThrow();
  });
});
