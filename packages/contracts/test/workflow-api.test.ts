import { describe, expect, it } from 'vitest';
import {
  initializeProjectWorkflowRequestSchema,
  saveWorkflowDraftRequestSchema,
  saveWorkflowDraftResponseSchema,
  workflowResponseSchema,
  publishWorkflowRequestSchema,
  workflowVersionResponseSchema,
  workflowVersionListResponseSchema,
} from '../src/index.js';

const draft = { inputs: [], nodes: [], edges: [], outputs: [] };
const workflow = {
  id: 'workflow-1',
  projectId: '00000000-0000-4000-8000-000000000001',
  name: '默认工作流',
  revision: 3,
  draft,
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:01:00.000Z',
};

describe('Workflow 编辑 HTTP 契约', () => {
  it('读取响应保留独立身份、完整草稿与修订，拒绝内部字段', () => {
    expect(workflowResponseSchema.parse(JSON.parse(JSON.stringify(workflow)))).toEqual(workflow);
    for (const extra of [
      { ownerId: 'owner' },
      { versions: [] },
      { encryptedCredentials: 'secret' },
    ])
      expect(workflowResponseSchema.safeParse({ ...workflow, ...extra }).success).toBe(false);
  });

  it('初始化仅接受空请求，身份与初始草稿不由调用方指定', () => {
    expect(initializeProjectWorkflowRequestSchema.parse(undefined)).toEqual({});
    expect(initializeProjectWorkflowRequestSchema.parse({})).toEqual({});
    for (const value of [null, { workflowId: 'chosen' }, { ownerId: 'other' }, { draft }])
      expect(initializeProjectWorkflowRequestSchema.safeParse(value).success).toBe(false);
  });

  it('保存必须显式传 expectedRevision 与完整 Definition，不能混入项目 revision 或发布字段', () => {
    const request = { expectedRevision: 3, definition: draft };
    expect(saveWorkflowDraftRequestSchema.parse(request)).toEqual(request);
    for (const value of [
      { definition: draft },
      { revision: 3, definition: draft },
      { ...request, expectedRevision: 0 },
      { ...request, expectedRevision: 1.5 },
      { ...request, workflowId: 'other' },
      { ...request, publish: true },
      { ...request, definition: { nodes: [] } },
    ])
      expect(saveWorkflowDraftRequestSchema.safeParse(value).success).toBe(false);
    expect(saveWorkflowDraftResponseSchema.parse({ revision: 4 })).toEqual({ revision: 4 });
  });
});

describe('Workflow 发布与版本 HTTP 契约', () => {
  it('发布只接受 expectedRevision，不接受客户端替换定义或身份', () => {
    expect(publishWorkflowRequestSchema.parse({ expectedRevision: 2 })).toEqual({
      expectedRevision: 2,
    });
    for (const value of [
      {},
      { expectedRevision: '2' },
      { expectedRevision: 0 },
      { expectedRevision: 2, definition: draft },
      { expectedRevision: 2, workflowId: 'other' },
    ])
      expect(publishWorkflowRequestSchema.safeParse(value).success).toBe(false);
  });

  it('版本完整响应和列表摘要保留来源修订，拒绝秘密或草稿状态字段', () => {
    const version = {
      id: 'version-1',
      workflowId: workflow.id,
      projectId: workflow.projectId,
      version: 1,
      sourceRevision: 3,
      publishedAt: workflow.createdAt,
      definition: draft,
    };
    expect(workflowVersionResponseSchema.parse(JSON.parse(JSON.stringify(version)))).toEqual(
      version,
    );
    const { definition: _definition, ...summary } = version;
    expect(
      workflowVersionListResponseSchema.parse({ items: [summary], nextBeforeVersion: null }),
    ).toEqual({ items: [summary], nextBeforeVersion: null });
    for (const extra of [
      { encryptedCredentials: 'secret' },
      { ownerId: 'owner' },
      { draft },
      { enabled: true },
    ])
      expect(workflowVersionResponseSchema.safeParse({ ...version, ...extra }).success).toBe(false);
    expect(
      workflowVersionListResponseSchema.safeParse({ items: [version], nextBeforeVersion: null })
        .success,
    ).toBe(false);
  });
});
