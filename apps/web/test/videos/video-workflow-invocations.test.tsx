// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App, ConfigProvider } from 'antd';
import type { AnchorHTMLAttributes } from 'react';
import {
  StringType,
  type Project,
  type Video,
  type WorkflowResponse,
  type WorkflowVersionResponse,
  type WorkflowRunResponse,
  type ProductWorkflowInvocation,
} from '@dramaflow/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoDetail } from '../../src/features/videos/detail/video-detail';
import { ProjectWorkspaceContext } from '../../src/features/projects/workspace/workspace-context';
import { workflowApi } from '../../src/features/workflow/workflow-api';
import { productInvocationApi } from '../../src/features/videos/workflow-invocations/product-invocation-api';
import { videoApi } from '../../src/features/videos/api/video-api';
import { InvocationReceiptStore } from '../../src/features/workflow/run/recovery/invocation-receipts';
import { ApiError } from '../../src/lib/http';

vi.mock('next/navigation', () => ({
  usePathname: () => '/projects/current/videos/current',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({
    onNavigate,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { onNavigate?: unknown }) => (
    <a
      {...props}
      onClick={(event) => {
        event.preventDefault();
        if (typeof onNavigate === 'function') onNavigate({ preventDefault() {} });
      }}
    />
  ),
}));
vi.mock('../../src/features/auth/use-identity', () => ({
  useIdentity: () => ({ data: { id: 'user-video' } }),
}));
vi.mock('../../src/features/videos/api/video-api', async (original) => ({
  ...(await original<typeof import('../../src/features/videos/api/video-api')>()),
  videoApi: { get: vi.fn() },
}));
vi.mock(
  '../../src/features/videos/workflow-invocations/product-invocation-api',
  async (original) => ({
    ...(await original<
      typeof import('../../src/features/videos/workflow-invocations/product-invocation-api')
    >()),
    productInvocationApi: { start: vi.fn(), list: vi.fn(), get: vi.fn(), lookup: vi.fn() },
  }),
);
vi.mock('../../src/features/workflow/workflow-api', async (original) => ({
  ...(await original<typeof import('../../src/features/workflow/workflow-api')>()),
  workflowApi: {
    get: vi.fn(),
    listVersions: vi.fn(),
    getVersion: vi.fn(),
    startRun: vi.fn(),
    lookupInvocation: vi.fn(),
    getRun: vi.fn(),
    getNodeRuns: vi.fn(),
    getExecutionTree: vi.fn(),
  },
}));
const createdAt = '2026-10-30T00:00:00.000Z';
const project: Project = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '作品项目',
  revision: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  createdAt,
  updatedAt: createdAt,
};
const video: Video = {
  id: '00000000-0000-4000-8000-000000000002',
  projectId: project.id,
  name: '作品 A',
  status: 'draft',
  revision: 1,
  createdAt,
  updatedAt: createdAt,
};
const workflow: WorkflowResponse = {
  id: 'workflow-1',
  projectId: project.id,
  name: '当前项目工作流',
  revision: 1,
  createdAt,
  updatedAt: createdAt,
  draft: { inputs: [], nodes: [], edges: [], outputs: [] },
};
const version: WorkflowVersionResponse = {
  id: 'version-1',
  workflowId: workflow.id,
  projectId: project.id,
  version: 1,
  sourceRevision: 1,
  publishedAt: createdAt,
  definition: {
    inputs: [{ name: 'prompt', type: StringType, required: true }],
    nodes: [],
    edges: [],
    outputs: [],
  },
};
const run: WorkflowRunResponse = {
  id: 'run-1',
  workflowId: workflow.id,
  workflowVersionId: version.id,
  invocationKey: 'key-1',
  inputs: {},
  status: 'completed',
  outputs: {},
  createdAt,
};
const invocation: ProductWorkflowInvocation = {
  id: '00000000-0000-4000-8000-000000000003',
  projectId: project.id,
  sourceVideoId: video.id,
  sourceVideoName: video.name,
  workflowRunId: run.id,
  invocationKey: run.invocationKey,
  createdAt,
};
const scope = {
  userId: 'user-video',
  projectId: project.id,
  workflowId: workflow.id,
  callerNamespace: `product-workflow:${video.id}`,
};
const metadata = {
  projectId: project.id,
  workflowId: workflow.id,
  workflowVersionId: version.id,
  invocationKey: run.invocationKey,
  createdAt,
};
const context = {
  project,
  requestLeave: (action: () => void | Promise<void>) => void action(),
  registerLeaveGuard: () => () => {},
};

function mount() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <QueryClientProvider client={cache}>
          <ProjectWorkspaceContext.Provider value={context}>
            <VideoDetail videoId={video.id} />
          </ProjectWorkspaceContext.Provider>
        </QueryClientProvider>
      </App>
    </ConfigProvider>,
  );
  return { ...view, cache };
}
async function submit() {
  const input = await screen.findByRole('textbox', { name: 'prompt 输入' });
  fireEvent.change(input, { target: { value: '作品输入' } });
  const button = await screen.findByRole('button', { name: /^运\s*行$/ });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}
function unloadPrevented() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
beforeEach(() => {
  window.localStorage.clear();
  vi.resetAllMocks();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      media,
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.mocked(videoApi.get).mockResolvedValue(video);
  vi.mocked(workflowApi.get).mockResolvedValue(workflow);
  vi.mocked(workflowApi.listVersions).mockResolvedValue({
    items: [version],
    nextBeforeVersion: null,
  });
  vi.mocked(workflowApi.getVersion).mockResolvedValue(version);
  vi.mocked(workflowApi.getRun).mockResolvedValue(run);
  vi.mocked(workflowApi.getNodeRuns).mockResolvedValue({ items: [] });
  vi.mocked(workflowApi.getExecutionTree).mockResolvedValue({
    run: {
      type: 'workflow_run',
      id: run.id,
      workflowId: workflow.id,
      workflowVersionId: version.id,
      status: run.status,
      createdAt,
    },
    parent: { type: 'workflow_run', id: run.id },
    items: [],
    nextCursor: null,
  });
  vi.mocked(productInvocationApi.list).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(productInvocationApi.lookup).mockResolvedValue({ invocation: null });
  vi.mocked(productInvocationApi.get).mockResolvedValue({ invocation, run });
  vi.mocked(productInvocationApi.start).mockImplementation(async (_project, _video, input) => {
    const result = {
      invocation: { ...invocation, invocationKey: input.invocationKey },
      run: { ...run, invocationKey: input.invocationKey, inputs: input.inputs },
    };
    vi.mocked(productInvocationApi.list).mockResolvedValue({
      items: [result.invocation],
      nextCursor: null,
    });
    vi.mocked(workflowApi.getRun).mockResolvedValue(result.run);
    return result;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Video 的真实 Workflow 调用入口', () => {
  it('后台工作流读取短暂失败保留当前输入；明确拒绝访问时隐藏调用入口', async () => {
    const view = mount();
    const input = await screen.findByRole('textbox', { name: 'prompt 输入' });
    fireEvent.change(input, { target: { value: '尚未提交的作品输入' } });
    vi.mocked(workflowApi.get).mockRejectedValue(new Error('暂时断开'));
    await view.cache.invalidateQueries({ queryKey: ['project-workflow', project.id] });
    expect(await screen.findByText('工作流信息暂时无法刷新，当前输入仍保留')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'prompt 输入' }) as HTMLInputElement).value).toBe(
      '尚未提交的作品输入',
    );
    vi.mocked(workflowApi.get).mockRejectedValue(new ApiError('无权访问', 403));
    await view.cache.invalidateQueries({ queryKey: ['project-workflow', project.id] });
    expect(await screen.findByText('项目工作流读取失败')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'prompt 输入' })).toBeNull();
    expect(productInvocationApi.start).not.toHaveBeenCalled();
  });
  it('从空调用记录选择发布版本、复用输入表单，通过产品入口受理并查看现有运行与 Tree', async () => {
    mount();
    expect(await screen.findByText('尚未从这个视频发起工作流调用。')).toBeTruthy();
    expect(await screen.findByRole('combobox', { name: '选择已发布版本' })).toBeTruthy();
    await submit();
    await waitFor(() =>
      expect(productInvocationApi.start).toHaveBeenCalledExactlyOnceWith(project.id, video.id, {
        workflowVersionId: version.id,
        invocationKey: expect.any(String),
        inputs: { prompt: { storage: 'inline', type: StringType, value: '作品输入' } },
      }),
    );
    expect(await screen.findByText('已完成')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '查看运行与执行树' }));
    expect(await screen.findByText(`来源作品：${video.name}`)).toBeTruthy();
    fireEvent.click(await screen.findByText('执行树', { selector: '.ant-collapse-title' }));
    await waitFor(() =>
      expect(workflowApi.getExecutionTree).toHaveBeenCalledWith(
        run.id,
        expect.objectContaining({ parentType: 'workflow_run' }),
        expect.any(AbortSignal),
      ),
    );
    expect(workflowApi.startRun).not.toHaveBeenCalled();
    expect(workflowApi.lookupInvocation).not.toHaveBeenCalled();
  });
  it('没有发布版本时显示真实空状态并阻止提交，读取失败不伪装空状态', async () => {
    vi.mocked(workflowApi.listVersions).mockResolvedValue({ items: [], nextBeforeVersion: null });
    const view = mount();
    expect(await screen.findByText('暂无已发布版本')).toBeTruthy();
    expect((screen.getByRole('button', { name: /^运\s*行$/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    vi.mocked(productInvocationApi.list).mockRejectedValue(new Error('读取中断'));
    await view.cache.invalidateQueries({ queryKey: ['product-invocations'] });
    expect(await screen.findByText('调用记录读取失败')).toBeTruthy();
    expect(screen.queryByText('尚未从这个视频发起工作流调用。')).toBeNull();
    expect(productInvocationApi.start).not.toHaveBeenCalled();
  });
  it('dispatch 不明保护离开；重进后只通过产品查询恢复同一次调用，不重新 POST', async () => {
    vi.mocked(productInvocationApi.start).mockRejectedValue(
      new ApiError('结果尚未确认', 503, {
        code: 'WORKFLOW_QUEUE_UNAVAILABLE',
        workflowRunId: run.id,
      }),
    );
    const view = mount();
    await submit();
    expect(await screen.findByText('上一次运行请求尚未确认')).toBeTruthy();
    await waitFor(() => expect(unloadPrevented()).toBe(true));
    const [receipt] = new InvocationReceiptStore(scope, () => window.localStorage).list().receipts;
    expect(receipt?.workflowRunId).toBe(run.id);
    vi.mocked(productInvocationApi.lookup).mockResolvedValue({
      invocation: { ...invocation, invocationKey: receipt!.invocationKey },
    });
    vi.mocked(productInvocationApi.get).mockResolvedValue({
      invocation: { ...invocation, invocationKey: receipt!.invocationKey },
      run: { ...run, invocationKey: receipt!.invocationKey },
    });
    view.unmount();
    mount();
    expect(await screen.findByText('已完成')).toBeTruthy();
    expect(productInvocationApi.lookup).toHaveBeenCalledWith(project.id, receipt!.invocationKey);
    expect(productInvocationApi.start).toHaveBeenCalledTimes(1);
    expect(workflowApi.startRun).not.toHaveBeenCalled();
    await waitFor(() => expect(unloadPrevented()).toBe(false));
  });
  it('其他 Video 和 Canvas 的恢复标识不查询；同 key 来源不符也不展示为当前作品调用', async () => {
    const storage = () => window.localStorage;
    new InvocationReceiptStore({ ...scope, callerNamespace: undefined }, storage).save({
      ...metadata,
      invocationKey: 'canvas',
    });
    new InvocationReceiptStore(
      { ...scope, callerNamespace: 'product-workflow:other' },
      storage,
    ).save({ ...metadata, invocationKey: 'other' });
    new InvocationReceiptStore(scope, storage).save(metadata);
    vi.mocked(productInvocationApi.lookup).mockResolvedValue({
      invocation: { ...invocation, sourceVideoId: '00000000-0000-4000-8000-000000000009' },
    });
    mount();
    expect(await screen.findByText('上一次运行请求尚未确认')).toBeTruthy();
    expect(productInvocationApi.lookup).toHaveBeenCalledExactlyOnceWith(
      project.id,
      metadata.invocationKey,
    );
    expect(productInvocationApi.get).not.toHaveBeenCalled();
    expect(screen.queryByText('已完成')).toBeNull();
    expect(productInvocationApi.start).not.toHaveBeenCalled();
  });
});
