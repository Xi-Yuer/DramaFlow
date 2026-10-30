// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App, ConfigProvider } from 'antd';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Edge, Node, ReactFlowProps } from '@xyflow/react';
import type { WorkflowRunSummary, ExecutionTreeEntry } from '@dramaflow/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasEditor } from '../../../../src/features/workflow/editor/canvas-editor';
import { WorkflowRunHistory } from '../../../../src/features/workflow/run/history/workflow-run-history';
import { workflowApi } from '../../../../src/features/workflow/workflow-api';
import { graphExecutionFixture } from '../../../fixtures/graph-execution';
import { nodeCatalogKeys } from '../../../../src/features/workflow/node-catalog/node-catalog-api';
import { nodeTypeKeys } from '../../../../src/features/workflow/node-catalog/node-type-api';
import { createSubworkflowNodeType } from '../../../../../../packages/workflow/src/node/builtin/subworkflow';
import { createTextGenerationNodeType } from '../../../../../../packages/workflow/src/node/builtin/text-generation';
import { GenericWorkflowNode } from '../../../../src/features/workflow/canvas/rendering/workflow-node';
import {
  fromReactFlowNode,
  toReactFlowNode,
} from '../../../../src/features/workflow/canvas/adapter/node-adapter';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../../../src/features/auth/use-identity', () => ({
  useIdentity: () => ({ data: undefined }),
}));
vi.mock('../../../../src/features/models/model-settings', () => ({ ModelSettings: () => null }));
vi.mock('../../../../src/features/workflow/model-selection/model-selector', () => ({
  ModelSelector: () => null,
}));
vi.mock('../../../../src/features/workflow/editor/presentation/editor-toolbar', () => ({
  EditorToolbar: () => null,
}));
vi.mock('../../../../src/features/workflow/editor/presentation/editor-notices', () => ({
  EditorNotices: () => null,
}));
vi.mock('../../../../src/features/workflow/publish/workflow-publish-controls', () => ({
  WorkflowPublishControls: () => null,
}));
vi.mock('../../../../src/features/workflow/publish/use-workflow-publish', () => ({
  useWorkflowPublish: () => ({
    latestPublishedVersion: null,
    currentSavedRevisionPublished: false,
    publishing: false,
    versions: { isSuccess: true },
  }),
}));
vi.mock('@xyflow/react', async (original) => ({
  ...(await original<typeof import('@xyflow/react')>()),
  useReactFlow: () => ({
    screenToFlowPosition: (point: unknown) => point,
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    setViewport: () => undefined,
  }),
  ReactFlow: (props: ReactFlowProps<Node, Edge>) => (
    <div>
      {props.nodes
        ?.filter((node) => node.type === 'workflowNode')
        .map((node) => {
          const exact = toReactFlowNode(fromReactFlowNode(node));
          return (
            <div
              key={node.id}
              data-testid={`flow-${node.id}`}
              onClick={(event) => props.onNodeClick?.(event, node)}
              onDoubleClick={(event) => props.onNodeDoubleClick?.(event, node)}
            >
              <GenericWorkflowNode
                id={exact.id}
                data={exact.data}
                type="workflowNode"
                dragging={false}
                selected={false}
                zIndex={0}
                selectable
                deletable
                draggable
                isConnectable
                positionAbsoluteX={0}
                positionAbsoluteY={0}
              />
            </div>
          );
        })}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function provider(
  children: React.ReactNode,
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }),
) {
  return (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <QueryClientProvider client={cache}>{children}</QueryClientProvider>
      </App>
    </ConfigProvider>
  );
}
function summary(f = graphExecutionFixture()): WorkflowRunSummary {
  return {
    id: f.run.id,
    workflowId: f.run.workflowId,
    workflowVersionId: f.version.id,
    version: 1,
    status: f.run.status,
    createdAt: f.run.createdAt,
  };
}
function setupEditor() {
  const f = graphExecutionFixture();
  f.childRun.outputs = {
    text: { storage: 'inline', type: { kind: 'primitive', name: 'string' }, value: '历史内部输出' },
  };
  const draft = structuredClone(f.workflow);
  draft.nodes[0]!.name = '已修改的草稿节点';
  draft.nodes[0]!.config.changed = true;
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
  });
  cache.setQueryData(nodeCatalogKeys.list, []);
  cache.setQueryData(nodeTypeKeys.list, [
    createSubworkflowNodeType().manifest,
    createTextGenerationNodeType().manifest,
  ]);
  vi.spyOn(workflowApi, 'listVersions').mockResolvedValue({
    items: [{ ...f.version, id: 'latest', version: 2 }],
    nextBeforeVersion: null,
  });
  const version = vi
    .spyOn(workflowApi, 'getVersion')
    .mockImplementation(async (id) =>
      id === 'latest' ? { ...f.version, id, version: 2, definition: draft } : f.version,
    );
  const history = vi
    .spyOn(workflowApi, 'listRuns')
    .mockResolvedValue({ items: [summary(f)], nextCursor: null });
  const getRun = vi.spyOn(workflowApi, 'getRun').mockResolvedValue(f.run);
  const getNodeRuns = vi.spyOn(workflowApi, 'getNodeRuns').mockResolvedValue({ items: f.nodeRuns });
  const tree = vi.spyOn(workflowApi, 'getExecutionTree').mockImplementation(async (_run, query) => {
    if (query.parentType === 'node_run') return f.page();
    const entry: ExecutionTreeEntry = {
      type: 'node_run',
      id: f.parentRun.id,
      nodeId: f.owner.id,
      occurrenceId: f.parentRun.occurrenceId,
      attempt: 1,
      status: 'completed',
      startedAt: f.parentRun.startedAt,
      parent: { type: 'workflow_run', id: f.run.id },
    };
    return {
      run: { ...f.run, type: 'workflow_run' },
      parent: { type: query.parentType, id: query.parentId ?? f.run.id },
      items: query.parentType === 'workflow_run' ? [entry] : [],
      nextCursor: null,
    };
  });
  const save = vi.spyOn(workflowApi, 'saveDraft');
  render(
    provider(
      <CanvasEditor
        project={{
          id: f.projectId,
          name: '历史测试',
          revision: 1,
          createdAt: f.run.createdAt,
          updatedAt: f.run.createdAt,
        }}
        workflow={{
          id: f.run.workflowId,
          projectId: f.projectId,
          name: '工作流',
          revision: 2,
          draft,
          metadataRevision: 1,
          viewport: { x: 0, y: 0, zoom: 1 },
          createdAt: f.run.createdAt,
          updatedAt: f.run.createdAt,
        }}
      />,
      cache,
    ),
  );
  return { ...f, draft, cache, history, version, tree, save, getRun, getNodeRuns };
}
async function selectRun(id = 'run') {
  fireEvent.click(screen.getByRole('button', { name: '运行历史' }));
  fireEvent.click(await screen.findByRole('button', { name: `查看运行 ${id}` }));
}
describe('Run History 正式 Web 入口', () => {
  it('只消费服务端 cancellation projection：取消中 / uncertain / cancelled，历史不推导 Outbox', async () => {
    const f = graphExecutionFixture();
    const base = summary(f);
    vi.spyOn(workflowApi, 'listRuns').mockResolvedValue({
      items: [
        { ...base, id: 'requested', status: 'running', cancellation: 'requested' },
        { ...base, id: 'uncertain', status: 'running', cancellation: 'uncertain' },
        { ...base, id: 'cancelled', status: 'cancelled', cancellation: 'none' },
      ],
      nextCursor: null,
    });
    render(
      provider(
        <WorkflowRunHistory
          projectId={f.projectId}
          workflowId={f.run.workflowId}
          onSelect={vi.fn()}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '运行历史' }));
    await screen.findByText('取消中');
    expect(screen.getByText('暂无法确认停止')).toBeTruthy();
    expect(screen.getByText('已取消')).toBeTruthy();
    expect(screen.queryByText('recovery_required')).toBeNull();
  });
  it('懒加载、分页和摘要，不展示内部执行字段', async () => {
    const f = graphExecutionFixture();
    const first = summary(f),
      second = {
        ...first,
        id: 'failed-run',
        status: 'failed' as const,
        error: { stage: 'invoke', message: '执行失败摘要' },
      };
    const load = vi
      .spyOn(workflowApi, 'listRuns')
      .mockResolvedValueOnce({ items: [first], nextCursor: 'next' })
      .mockResolvedValueOnce({ items: [second], nextCursor: null });
    const select = vi.fn();
    render(
      provider(
        <WorkflowRunHistory
          projectId={f.projectId}
          workflowId={f.run.workflowId}
          onSelect={select}
        />,
      ),
    );
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '运行历史' }));
    await screen.findByRole('button', { name: '查看运行 run' });
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await screen.findByText('执行失败摘要');
    expect(load.mock.calls[1]![2]).toBe('next');
    fireEvent.click(screen.getByRole('button', { name: '查看运行 failed-run' }));
    expect(select).toHaveBeenCalledWith(second);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('历史选择加载自身 immutable Version，复用 Tree / Canvas / Inspector；返回草稿保留 mismatch', async () => {
    const f = setupEditor();
    await screen.findByText('已修改的草稿节点');
    await selectRun();
    await screen.findByText('正在只读查看历史运行 · v1');
    await waitFor(() =>
      expect(document.querySelector('[data-execution-instance="run"]')).toBeTruthy(),
    );
    expect(screen.queryByText('已修改的草稿节点')).toBeNull();
    expect(f.version).toHaveBeenCalledWith(f.run.workflowVersionId);
    const process = await screen.findByRole('region', { name: '执行过程' });
    expect(within(process).getByText('AI 文本处理')).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加节点' })).toHaveProperty('disabled', true);
    fireEvent.doubleClick(screen.getByTestId('flow-process_text'));
    await waitFor(() =>
      expect(document.querySelector('[data-execution-instance="child-execution-1"]')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('flow-generate'));
    fireEvent.click(screen.getByRole('tab', { name: '运行状态' }));
    expect(await screen.findByText('历史内部输出')).toBeTruthy();
    const inspector = screen.getByRole('complementary', { name: '节点检查器' });
    expect(inspector.querySelector('[data-runtime-status="completed"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回草稿' }));
    await screen.findByText('已修改的草稿节点');
    expect(document.querySelector('[data-execution-projection="version_mismatch"]')).toBeTruthy();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.draft.nodes[0]!.name).toBe('已修改的草稿节点');
  });
  it('历史 Version 读取失败不降级显示 Draft 的运行状态', async () => {
    const f = setupEditor();
    await screen.findByText('已修改的草稿节点');
    f.version.mockRejectedValue(new Error('不可用'));
    await selectRun();
    await screen.findByText('历史发布版本读取失败');
    expect(document.querySelector('[data-execution-instance]')).toBeNull();
    expect(screen.queryByText('已修改的草稿节点')).toBeNull();
  });
});

it('空历史、读取失败和跨 Workflow 响应都有明确状态，不触发运行', async () => {
  const f = graphExecutionFixture();
  const load = vi.spyOn(workflowApi, 'listRuns').mockResolvedValue({ items: [], nextCursor: null });
  render(
    provider(
      <WorkflowRunHistory
        projectId={f.projectId}
        workflowId={f.run.workflowId}
        onSelect={vi.fn()}
      />,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: '运行历史' }));
  await screen.findByText('暂无历史运行');
  load.mockRejectedValueOnce(new Error('不可用'));
  fireEvent.click(screen.getByRole('button', { name: '刷新历史' }));
  await screen.findByText('运行历史读取失败');
  load.mockResolvedValueOnce({
    items: [{ ...summary(f), workflowId: 'another-workflow' }],
    nextCursor: null,
  });
  fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  expect(screen.queryByRole('button', { name: '查看运行 run' })).toBeNull();
});

it('切换另一历史 Run 时撤下旧状态，等待该 Run 自己的版本再投影', async () => {
  const f = setupEditor(),
    second = graphExecutionFixture();
  second.run.id = 'second-run';
  second.run.workflowVersionId = 'second-version';
  second.version.id = 'second-version';
  second.version.version = 3;
  second.owner.name = '历史版本三';
  second.version.definition = structuredClone(second.workflow);
  second.parentRun.id = 'second-parent';
  second.parentRun.workflowRunId = second.run.id;
  second.childRun.id = 'second-child-node';
  second.childRun.workflowRunId = second.run.id;
  second.childRun.childExecutionId = 'second-child';
  second.execution.id = 'second-child';
  second.execution.parent = { type: 'node_run', id: 'second-parent' };
  second.childRun.outputs = {
    text: { storage: 'inline', type: { kind: 'primitive', name: 'string' }, value: '另一运行输出' },
  };
  let resolve!: (version: typeof second.version) => void;
  const pending = new Promise<typeof second.version>((done) => (resolve = done));
  const originalVersion = f.version.getMockImplementation()!;
  f.version.mockImplementation((id) => (id === second.version.id ? pending : originalVersion(id)));
  f.history.mockResolvedValue({ items: [summary(), summary(second)], nextCursor: null });
  f.getRun.mockImplementation(async (id) => (id === second.run.id ? second.run : f.run));
  f.getNodeRuns.mockImplementation(async (id) => ({
    items: id === second.run.id ? second.nodeRuns : f.nodeRuns,
  }));
  const originalTree = f.tree.getMockImplementation()!;
  f.tree.mockImplementation(async (runId, query, signal) =>
    runId !== second.run.id
      ? originalTree(runId, query, signal)
      : query.parentType === 'node_run'
        ? second.page()
        : {
            run: { ...second.run, type: 'workflow_run' },
            parent: { type: query.parentType, id: query.parentId ?? runId },
            items: [],
            nextCursor: null,
          },
  );
  await selectRun();
  await screen.findByText('正在只读查看历史运行 · v1');
  fireEvent.doubleClick(screen.getByTestId('flow-process_text'));
  await waitFor(() =>
    expect(document.querySelector('[data-execution-instance="child-execution-1"]')).toBeTruthy(),
  );
  await selectRun('second-run');
  expect(screen.queryByTestId('flow-generate')).toBeNull();
  expect(document.querySelector('[data-execution-instance]')).toBeNull();
  await act(async () => {
    resolve(second.version);
  });
  await screen.findByText('正在只读查看历史运行 · v3');
  await waitFor(() =>
    expect(document.querySelector('[data-execution-instance="second-run"]')).toBeTruthy(),
  );
  fireEvent.doubleClick(screen.getByTestId('flow-process_text'));
  await waitFor(() =>
    expect(document.querySelector('[data-execution-instance="second-child"]')).toBeTruthy(),
  );
  fireEvent.click(screen.getByTestId('flow-generate'));
  fireEvent.click(screen.getByRole('tab', { name: '运行状态' }));
  expect(await screen.findByText('另一运行输出')).toBeTruthy();
  expect(screen.queryByText('历史内部输出')).toBeNull();
});
