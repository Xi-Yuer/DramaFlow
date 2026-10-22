import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowResponse, WorkflowVersionResponse } from '@dramaflow/contracts';
import { ApiError } from '../src/lib/http';
import { workflowApi } from '../src/features/workflow/workflow-api';
import {
  WorkflowPublisher,
  workflowPublishError,
  workflowPublicationForRevision,
} from '../src/features/workflow/publish/workflow-publish';
import {
  createWorkflowDraftState,
  workflowDraftReducer,
  workflowPublishDisabledReason,
} from '../src/features/workflow/editor/workflow-draft-state';

const workflow: WorkflowResponse = {
  id: 'workflow-1',
  projectId: '7ac10b00-33cc-4e50-9a2b-05ef764c44f4',
  name: '默认工作流',
  revision: 7,
  createdAt: '2026-10-22T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
  draft: { inputs: [], nodes: [], edges: [], outputs: [] },
};
const version: WorkflowVersionResponse = {
  id: 'immutable-version-id',
  workflowId: workflow.id,
  projectId: workflow.projectId,
  version: 3,
  sourceRevision: 7,
  publishedAt: '2026-10-22T01:00:00.000Z',
  definition: workflow.draft,
};
const { definition: omitted, ...identity } = version;
void omitted;
function fixture() {
  let draft = createWorkflowDraftState(structuredClone(workflow));
  let operation: 'idle' | 'saving' | 'reloading' | 'publishing' = 'idle';
  const publish = vi.fn().mockResolvedValue(version);
  const refresh = vi.fn().mockResolvedValue({ latest: identity, current: identity });
  const conflict = vi.fn((message: string) => {
    draft = workflowDraftReducer(draft, { type: 'revision-conflict', message });
  });
  const end = vi.fn(() => {
    operation = 'idle';
  });
  const publisher = new WorkflowPublisher({
    begin: () => {
      if (workflowPublishDisabledReason(draft, operation)) return null;
      operation = 'publishing';
      return { workflowId: draft.workflowId, revision: draft.revision };
    },
    end,
    conflict,
    publish,
    refresh,
  });
  return {
    publisher,
    publish,
    refresh,
    conflict,
    end,
    get draft() {
      return draft;
    },
    setDraft: (next: typeof draft) => {
      draft = next;
    },
    setOperation: (next: typeof operation) => {
      operation = next;
    },
  };
}
const failure = (code: string, status = 409) => new ApiError('服务端拒绝发布', status, { code });
afterEach(() => vi.unstubAllGlobals());

describe('独立 Publish 受理状态', () => {
  it('clean 空草稿可以发布；发送保存 revision，保存版本 ID，刷新 versions，不更改 Draft', async () => {
    const f = fixture();
    const before = f.draft;
    await f.publisher.publish();
    expect(f.publish).toHaveBeenCalledExactlyOnceWith({ workflowId: workflow.id, revision: 7 });
    expect(f.refresh).toHaveBeenCalledExactlyOnceWith({ workflowId: workflow.id, revision: 7 });
    expect(f.publisher.getSnapshot()).toMatchObject({
      publishedVersion: identity,
      error: null,
      publishing: false,
    });
    expect(f.publisher.getSnapshot().publishedVersion).not.toHaveProperty('definition');
    expect(f.draft).toBe(before);
    expect(f.draft.revision).toBe(7);
    expect(f.end).toHaveBeenCalledOnce();
  });

  it.each(['dirty', 'saving', 'reloading', 'conflict', 'unconfirmed', 'publishing'])(
    '%s 时禁止发布，不隐式保存',
    async (kind) => {
      const f = fixture();
      if (kind === 'dirty')
        f.setDraft({
          ...f.draft,
          definition: {
            ...f.draft.definition,
            inputs: [
              { name: 'topic', type: { kind: 'primitive', name: 'string' }, required: true },
            ],
          },
        });
      if (kind === 'saving' || kind === 'reloading' || kind === 'publishing') f.setOperation(kind);
      if (kind === 'conflict') f.setDraft({ ...f.draft, conflict: true });
      if (kind === 'unconfirmed') f.setDraft({ ...f.draft, error: '保存结果未确认' });
      expect(
        workflowPublishDisabledReason(
          f.draft,
          kind === 'saving' || kind === 'reloading' || kind === 'publishing' ? kind : 'idle',
        ),
      ).not.toBeNull();
      await f.publisher.publish();
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.refresh).not.toHaveBeenCalled();
    },
  );

  it('同事件循环连续点击只发一次请求，请求完成后释放锁', async () => {
    const f = fixture();
    let release!: (value: WorkflowVersionResponse) => void;
    f.publish.mockImplementation(
      () =>
        new Promise<WorkflowVersionResponse>((resolve) => {
          release = resolve;
        }),
    );
    const first = f.publisher.publish();
    expect(f.publisher.getSnapshot().publishing).toBe(true);
    await f.publisher.publish();
    expect(f.publish).toHaveBeenCalledOnce();
    release(version);
    await first;
    expect(f.publisher.getSnapshot().publishing).toBe(false);
  });

  it('即使外部发生新编辑，发布完成也不能替换 Definition 或清除 dirty', async () => {
    const f = fixture();
    let release!: (value: WorkflowVersionResponse) => void;
    f.publish.mockImplementation(
      () =>
        new Promise<WorkflowVersionResponse>((resolve) => {
          release = resolve;
        }),
    );
    const task = f.publisher.publish();
    const edited = {
      ...f.draft.definition,
      outputs: [],
      inputs: [{ name: 'a', type: { kind: 'any' as const }, required: false }],
    };
    f.setDraft(workflowDraftReducer(f.draft, { type: 'edit', definition: edited }));
    const afterEdit = f.draft;
    release(version);
    await task;
    expect(f.draft).toBe(afterEdit);
    expect(f.draft.definition).toEqual(edited);
    expect(workflowPublishDisabledReason(f.draft)).toBe('请先保存草稿，再发布');
  });

  it('already-published 按 sourceRevision 恢复原版本，不能拿 latest 代替', async () => {
    const f = fixture();
    f.publish.mockRejectedValue(failure('WORKFLOW_REVISION_ALREADY_PUBLISHED'));
    f.refresh.mockResolvedValue({
      latest: { ...identity, id: 'newer-version', version: 4, sourceRevision: 8 },
      current: identity,
    });
    await f.publisher.publish();
    expect(f.publisher.getSnapshot().publishedVersion?.id).toBe(identity.id);
    expect(f.publisher.getSnapshot().error).toBeNull();
    expect(f.conflict).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it('already-published 但找不到该 revision 时不猜测成功', async () => {
    const f = fixture();
    f.publish.mockRejectedValue(failure('WORKFLOW_REVISION_ALREADY_PUBLISHED'));
    f.refresh.mockResolvedValue({ latest: { ...identity, sourceRevision: 8 }, current: null });
    await f.publisher.publish();
    expect(f.publisher.getSnapshot()).toMatchObject({
      publishedVersion: null,
      error: { code: 'WORKFLOW_PUBLISHED_VERSION_UNCONFIRMED' },
    });
    expect(f.conflict).not.toHaveBeenCalled();
  });

  it('revision conflict 走 Draft conflict/reload，保留内容且不标记发布', async () => {
    const f = fixture();
    const before = f.draft;
    f.publish.mockRejectedValue(failure('WORKFLOW_REVISION_CONFLICT'));
    await f.publisher.publish();
    expect(f.draft).toMatchObject({ revision: 7, conflict: true, definition: before.definition });
    expect(f.publisher.getSnapshot().publishedVersion).toBeNull();
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it('validation error 保留 code/requestId/nodeId/portKey/path，不保留原始配置', async () => {
    const f = fixture();
    f.publish.mockRejectedValue(
      new ApiError('校验失败', 400, {
        code: 'WORKFLOW_PUBLISH_VALIDATION_FAILED',
        requestId: 'trace',
        details: [
          {
            code: 'INPUT_SOURCE_MISSING',
            nodeId: 'a',
            portKey: 'prompt',
            path: ['nodes', 0, 'inputs', 'prompt'],
            input: 'private-value',
          },
        ],
      }),
    );
    await f.publisher.publish();
    expect(f.publisher.getSnapshot().error).toMatchObject({
      status: 400,
      code: 'WORKFLOW_PUBLISH_VALIDATION_FAILED',
      requestId: 'trace',
      issues: [
        {
          code: 'INPUT_SOURCE_MISSING',
          nodeId: 'a',
          portKey: 'prompt',
          path: ['nodes', 0, 'inputs', 'prompt'],
        },
      ],
    });
    expect(JSON.stringify(f.publisher.getSnapshot())).not.toContain('private-value');
    expect(f.publisher.getSnapshot().publishedVersion).toBeNull();
    expect(
      workflowPublishError(new ApiError('输入错误', 400, { nodeId: 'a', portKey: 'system' }))
        .issues,
    ).toEqual([{ nodeId: 'a', portKey: 'system' }]);
  });

  it.each([new ApiError('后端失败', 500), new Error('网络未确认')])(
    '后端或网络失败不误报 published，并释放锁',
    async (error) => {
      const f = fixture();
      f.publish.mockRejectedValue(error);
      await f.publisher.publish();
      expect(f.publisher.getSnapshot()).toMatchObject({
        publishedVersion: null,
        publishing: false,
        error: { message: error.message },
      });
      expect(f.end).toHaveBeenCalledOnce();
    },
  );

  it('发布已确认但 versions 刷新失败时保留真实版本身份及刷新错误', async () => {
    const f = fixture();
    f.refresh.mockRejectedValue(new Error('刷新失败'));
    await f.publisher.publish();
    expect(f.publisher.getSnapshot()).toMatchObject({
      publishedVersion: identity,
      error: null,
      refreshError: { message: '刷新失败' },
    });
  });
});

describe('Publish 与版本查询 HTTP', () => {
  it('POST 只携带 expectedRevision，成功返回 immutable version identity', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(version, { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    expect(await workflowApi.publish(workflow.id, 7)).toEqual(version);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/api/v1/workflows/workflow-1/publish',
      expect.objectContaining({
        method: 'POST',
        body: '{"expectedRevision":7}',
        credentials: 'same-origin',
      }),
    );
  });

  it('读取最新摘要；当前 sourceRevision 必须精确相等', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ items: [identity], nextBeforeVersion: null }),
      );
    vi.stubGlobal('fetch', fetch);
    expect(await workflowApi.publicationStatus(workflow.id, 7)).toEqual({
      latest: identity,
      current: identity,
    });
    expect(await workflowApi.publicationStatus(workflow.id, 8)).toEqual({
      latest: identity,
      current: null,
    });
  });

  it('跨版本分页寻找当前保存修订，不以 latest identity 冒充', async () => {
    const latest = { ...identity, id: 'latest', version: 30, sourceRevision: 30 };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ items: [latest], nextBeforeVersion: 11 }))
      .mockResolvedValueOnce(Response.json({ items: [identity], nextBeforeVersion: null }));
    vi.stubGlobal('fetch', fetch);
    expect(await workflowApi.publicationStatus(workflow.id, 7)).toEqual({
      latest,
      current: identity,
    });
    expect(fetch.mock.calls[1][0]).toBe('/api/v1/workflows/workflow-1/versions?beforeVersion=11');
  });

  it('空列表正常表示从未发布，不阻止空 Workflow 发布', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ items: [], nextBeforeVersion: null })),
    );
    expect(await workflowApi.publicationStatus(workflow.id, 7)).toEqual({
      latest: null,
      current: null,
    });
    expect(workflowPublishDisabledReason(createWorkflowDraftState(workflow))).toBeNull();
  });

  it('列表失败或错误工作流不能伪造版本身份，错误游标不能无限循环', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ message: '列表失败' }, { status: 500 })),
    );
    await expect(workflowApi.publicationStatus(workflow.id, 7)).rejects.toMatchObject({
      status: 500,
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ items: [{ ...identity, workflowId: 'other' }], nextBeforeVersion: null }),
        ),
    );
    await expect(workflowApi.publicationStatus(workflow.id, 7)).rejects.toThrow(
      '版本列表与当前工作流不匹配',
    );
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ items: [{ ...identity, sourceRevision: 8 }], nextBeforeVersion: 3 }),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(workflowApi.publicationStatus(workflow.id, 6)).rejects.toThrow('分页游标无效');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('发布结果与保存修订的关联', () => {
  it('保留已确认的版本 ID，但不将旧版本或最新版本隐式绑定到新 revision', () => {
    expect(workflowPublicationForRevision(7, undefined, identity)).toEqual({
      latest: identity,
      current: identity,
    });
    expect(workflowPublicationForRevision(8, undefined, identity)).toEqual({
      latest: identity,
      current: null,
    });
    const newer = { ...identity, id: 'newer', version: 4, sourceRevision: 9 };
    expect(workflowPublicationForRevision(8, { latest: newer, current: null }, identity)).toEqual({
      latest: newer,
      current: null,
    });
    expect(
      workflowPublicationForRevision(7, { latest: newer, current: identity }, identity),
    ).toEqual({ latest: newer, current: identity });
  });
});
