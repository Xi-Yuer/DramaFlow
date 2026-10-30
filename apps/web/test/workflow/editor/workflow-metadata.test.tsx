// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkflowResponse } from '@dramaflow/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/lib/http';
import { workflowApi, workflowKeys } from '../../../src/features/workflow/workflow-api';
import type { GraphCanvasSessionHandle } from '../../../src/features/workflow/editor/navigation/graph-canvas-session';
import { useWorkflowMetadata } from '../../../src/features/workflow/editor/metadata/use-workflow-metadata';

const feedback = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  confirm: vi.fn<(options: { onOk: () => Promise<void> }) => void>(),
  push: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: feedback.push }) }));
vi.mock('antd', () => ({
  App: { useApp: () => ({ message: feedback, modal: { confirm: feedback.confirm } }) },
}));
vi.mock('../../../src/features/workflow/workflow-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/features/workflow/workflow-api')>()),
  workflowApi: { saveMetadata: vi.fn(), get: vi.fn(), remove: vi.fn() },
}));

const workflow: WorkflowResponse = {
  id: '7ac10b00-33cc-4e50-9a2b-05ef764c44f4',
  name: '原项目',
  revision: 1,
  metadataRevision: 1,
  projectId: '00000000-0000-4000-8000-000000000001',
  draft: { inputs: [], nodes: [], edges: [], outputs: [] },
  viewport: { x: 0, y: 0, zoom: 1 },
  createdAt: '2026-10-27T00:00:00.000Z',
  updatedAt: '2026-10-27T00:00:00.000Z',
};

function mount() {
  const cache = new QueryClient();
  cache.setQueryData(workflowKeys.detail(workflow.projectId, workflow.id), workflow);
  const session: RefObject<GraphCanvasSessionHandle | null> = {
    current: { getRootViewport: () => workflow.viewport, setRootViewport: vi.fn() },
  };
  return {
    ...renderHook(() => useWorkflowMetadata(workflow, session), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={cache}>{children}</QueryClientProvider>
      ),
    }),
    session,
    cache,
  };
}

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe('工作流元数据保存与冲突恢复', () => {
  it('同一时刻只保存一次，响应只确认提交快照，保留请求期间的新修改', async () => {
    let complete!: (value: { metadataRevision: number; updatedAt: string }) => void;
    vi.mocked(workflowApi.saveMetadata).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const { result, cache } = mount();
    act(() => result.current.setName('第一次修改'));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.save();
    });
    await act(async () => {
      await result.current.save();
    });
    expect(workflowApi.saveMetadata).toHaveBeenCalledExactlyOnceWith(
      workflow.projectId,
      workflow.id,
      {
        expectedMetadataRevision: 1,
        name: '第一次修改',
        viewport: workflow.viewport,
      },
    );
    act(() => result.current.setName('保存期间继续修改'));
    await act(async () => {
      complete({ metadataRevision: 2, updatedAt: workflow.updatedAt });
      await pending;
    });
    expect(result.current.revision).toBe(2);
    expect(result.current.name).toBe('保存期间继续修改');
    expect(result.current.dirty).toBe(true);
    expect(result.current.saving).toBe(false);
    expect(cache.getQueryData(workflowKeys.detail(workflow.projectId, workflow.id))).toMatchObject({
      name: '第一次修改',
      metadataRevision: 2,
    });
  });

  it('409 保留本地修改并阻止覆盖，确认重读后同步根画布视口与修订', async () => {
    vi.mocked(workflowApi.saveMetadata).mockRejectedValue(new ApiError('修订冲突', 409));
    const server = {
      ...workflow,
      name: '服务器项目',
      metadataRevision: 3,
      viewport: { x: 40, y: 20, zoom: 1.2 },
    };
    vi.mocked(workflowApi.get).mockResolvedValue(server);
    const { result, session } = mount();
    act(() => result.current.setName('本地修改'));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.conflict).toBe(true);
    expect(result.current.name).toBe('本地修改');
    await act(async () => {
      await result.current.save();
    });
    expect(workflowApi.saveMetadata).toHaveBeenCalledTimes(1);
    act(() => result.current.reloadMetadata());
    expect(workflowApi.get).not.toHaveBeenCalled();
    await act(async () => {
      await feedback.confirm.mock.calls[0]![0].onOk();
    });
    expect(session.current!.setRootViewport).toHaveBeenCalledWith(server.viewport);
    expect(result.current.name).toBe(server.name);
    expect(result.current.revision).toBe(3);
    expect(result.current.conflict).toBe(false);
    expect(result.current.dirty).toBe(false);
  });

  it('网络结果不明时保留修改与错误，不标记已保存或自动重放请求', async () => {
    vi.mocked(workflowApi.saveMetadata).mockRejectedValue(new Error('网络断开'));
    const { result } = mount();
    act(() => result.current.setName('待保存'));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.metadataError).toBe('网络断开');
    expect(result.current.dirty).toBe(true);
    expect(result.current.revision).toBe(1);
    expect(workflowApi.saveMetadata).toHaveBeenCalledTimes(1);
    expect(feedback.success).not.toHaveBeenCalled();
  });
});
