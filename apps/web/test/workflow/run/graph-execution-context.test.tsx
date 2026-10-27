// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App, ConfigProvider } from 'antd';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { Edge, Node, ReactFlowProps } from '@xyflow/react';
import { StringType, type WorkflowVersionResponse } from '@dramaflow/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGraphExecutionProjection } from '../../../src/features/workflow/runtime/use-graph-execution-projection';
import { workflowApi, workflowKeys } from '../../../src/features/workflow/workflow-api';
import { graphExecutionFixture, iterationExecutionFixture } from '../../fixtures/graph-execution';
import { GraphCanvasSession } from '../../../src/features/workflow/editor/navigation/graph-canvas-session';
import { nodeCatalogKeys } from '../../../src/features/workflow/node-catalog/node-catalog-api';
import { nodeTypeKeys } from '../../../src/features/workflow/node-catalog/node-type-api';
import { createSubworkflowNodeType } from '../../../../../packages/workflow/src/node/builtin/subworkflow';
import { createTextGenerationNodeType } from '../../../../../packages/workflow/src/node/builtin/text-generation';
import { createIterationNodeType } from '../../../../../packages/workflow/src/node/builtin/iteration';
import { GenericWorkflowNode } from '../../../src/features/workflow/canvas/rendering/workflow-node';
import {
  fromReactFlowNode,
  toReactFlowNode,
} from '../../../src/features/workflow/canvas/adapter/node-adapter';

vi.mock('../../../src/features/auth/use-identity', () => ({
  useIdentity: () => ({ data: undefined }),
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setupHook() {
  const f = graphExecutionFixture();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const version = vi.spyOn(workflowApi, 'getVersion').mockResolvedValue(f.version);
  const tree = vi.spyOn(workflowApi, 'getExecutionTree').mockResolvedValue(f.page());
  const input: Parameters<typeof useGraphExecutionProjection>[0] = {
    ...f,
    workflowId: f.run.workflowId,
  };
  const mount = () =>
    renderHook((props: typeof input) => useGraphExecutionProjection(props), {
      initialProps: input,
      wrapper: ({ children }) => (
        <QueryClientProvider client={cache}>{children}</QueryClientProvider>
      ),
    });
  return { ...f, cache, version, tree, input, mount };
}

describe('Graph Execution 查询上下文', () => {
  it('发布版本 / ChildExecution 正在读取时明确 loading，完成后 resolved', async () => {
    const f = setupHook();
    const pendingVersion = deferred<WorkflowVersionResponse>();
    const pendingTree = deferred<ReturnType<typeof f.page>>();
    f.version.mockReturnValue(pendingVersion.promise);
    f.tree.mockReturnValue(pendingTree.promise);
    const view = f.mount();
    expect(view.result.current.phase).toBe('loading');
    expect(f.tree).not.toHaveBeenCalled();
    await act(async () => {
      pendingVersion.resolve(graphExecutionFixture().version);
    });
    await waitFor(() => expect(f.tree).toHaveBeenCalledOnce());
    expect(view.result.current.phase).toBe('loading');
    await act(async () => {
      pendingTree.resolve(f.page());
    });
    await waitFor(() => expect(view.result.current.phase).toBe('resolved'));
  });

  it('没有运行、没有子执行、多个子执行和读取失败分别保留不同状态', async () => {
    const f = setupHook();
    f.tree.mockResolvedValue(f.page([]));
    const view = f.mount();
    await waitFor(() => expect(view.result.current.phase).toBe('no_execution'));
    f.tree.mockResolvedValue(f.page([f.execution, { ...f.execution, id: 'other-child' }]));
    await act(async () => {
      await f.cache.invalidateQueries({ queryKey: ['graph-execution-projection'] });
    });
    await waitFor(() => expect(view.result.current.phase).toBe('ambiguous'));
    f.tree.mockRejectedValue(new Error('连接失败'));
    await act(async () => {
      await f.cache.invalidateQueries({ queryKey: ['graph-execution-projection'] });
    });
    await waitFor(() => expect(view.result.current.phase).toBe('unavailable'));
    view.rerender({ ...f.input, runStatus: null });
    expect(view.result.current.phase).toBe('no_execution');
  });

  it('查询实际 Run 的版本，Draft 修改立刻清除旧投影；回到匹配定义可恢复', async () => {
    const f = setupHook();
    const view = f.mount();
    await waitFor(() => expect(view.result.current.phase).toBe('resolved'));
    expect(f.version).toHaveBeenCalledWith(f.run.workflowVersionId);
    const modified = structuredClone(f.workflow);
    modified.nodes[0]!.config.changed = true;
    view.rerender({ ...f.input, workflow: modified });
    expect(view.result.current.phase).toBe('version_mismatch');
    view.rerender(f.input);
    await waitFor(() => expect(view.result.current.phase).toBe('resolved'));
  });

  it('版本查询失败或 Run / NodeRuns 不可用时不显示旧执行状态', async () => {
    const f = setupHook();
    f.version.mockRejectedValue(new Error('版本不可读'));
    const view = f.mount();
    await waitFor(() => expect(view.result.current.phase).toBe('unavailable'));
    view.rerender({ ...f.input, runStatus: { ...f.runStatus, phase: 'loading' } });
    expect(view.result.current.phase).toBe('loading');
    view.rerender({ ...f.input, runStatus: { ...f.runStatus, phase: 'error' } });
    expect(view.result.current.phase).toBe('unavailable');
  });

  it('切换 Run 后迟到的旧 ChildExecution 响应不能覆盖新投影', async () => {
    const f = setupHook();
    const old = deferred<ReturnType<typeof f.page>>();
    f.tree.mockReturnValueOnce(old.promise);
    const view = f.mount();
    await waitFor(() => expect(f.tree).toHaveBeenCalledOnce());
    const run = { ...f.run, id: 'new-run' };
    const records = f.nodeRuns.map((record) => ({ ...record, workflowRunId: run.id }));
    f.tree.mockResolvedValue({ ...f.page(), run: { ...f.page().run, id: run.id } });
    view.rerender({
      ...f.input,
      runStatus: { ...f.runStatus, runId: run.id, run, nodeRuns: records },
    });
    await waitFor(() => expect(view.result.current.phase).toBe('resolved'));
    await act(async () => {
      old.resolve(f.page([]));
    });
    expect(view.result.current.phase).toBe('resolved');
  });
});

describe('Nested Canvas 与 Inspector 共用执行投影', () => {
  it.each(['completed', 'running', 'failed'] as const)(
    'SubWorkflow 下钻后卡片和 Inspector 同时显示 %s',
    async (status) => {
      const f = graphExecutionFixture();
      f.childRun.status = status;
      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      cache.setQueryData(workflowKeys.version(f.version.id), f.version);
      cache.setQueryData(nodeCatalogKeys.list, []);
      cache.setQueryData(nodeTypeKeys.list, [
        createSubworkflowNodeType().manifest,
        createTextGenerationNodeType().manifest,
      ]);
      vi.spyOn(workflowApi, 'getExecutionTree').mockResolvedValue(f.page());
      render(
        <ConfigProvider theme={{ token: { motion: false } }}>
          <App>
            <QueryClientProvider client={cache}>
              <GraphCanvasSession
                projectId={f.projectId}
                workflowId={f.run.workflowId}
                workflow={f.workflow}
                onEdit={() => undefined}
                onOpenProvider={() => undefined}
                reloading={false}
                initialRootViewport={{ x: 0, y: 0, zoom: 1 }}
                onRootViewportChange={() => undefined}
                runStatus={f.runStatus}
              />
            </QueryClientProvider>
          </App>
        </ConfigProvider>,
      );
      expect(
        screen.getByTestId('flow-process_text').querySelector('[data-runtime-status="completed"]'),
      ).toBeTruthy();
      fireEvent.doubleClick(screen.getByTestId('flow-process_text'));
      const card = await screen.findByTestId('flow-generate');
      await waitFor(() =>
        expect(card.querySelector(`[data-runtime-status="${status}"]`)).toBeTruthy(),
      );
      fireEvent.click(card);
      fireEvent.click(screen.getByRole('tab', { name: '运行状态' }));
      const inspector = screen.getByRole('complementary', { name: '节点检查器' });
      expect(inspector.querySelector(`[data-runtime-status="${status}"]`)).toBeTruthy();
      expect(within(inspector).getByLabelText('节点执行信息')).toBeTruthy();
      expect(document.querySelector('[data-execution-projection="resolved"]')).toBeTruthy();
    },
  );
});

function mountIterationItems(indexes = [2, 0, 1]) {
  const f = iterationExecutionFixture(indexes);
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
  });
  cache.setQueryData(workflowKeys.version(f.version.id), f.version);
  cache.setQueryData(nodeCatalogKeys.list, []);
  cache.setQueryData(nodeTypeKeys.list, [
    createIterationNodeType().manifest,
    createTextGenerationNodeType().manifest,
  ]);
  const tree = vi.spyOn(workflowApi, 'getExecutionTree').mockResolvedValue(f.page(f.executions));
  const view = render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <QueryClientProvider client={cache}>
          <GraphCanvasSession
            projectId={f.projectId}
            workflowId={f.run.workflowId}
            workflow={f.workflow}
            onEdit={() => undefined}
            onOpenProvider={() => undefined}
            reloading={false}
            initialRootViewport={{ x: 0, y: 0, zoom: 1 }}
            onRootViewportChange={() => undefined}
            runStatus={f.runStatus}
          />
        </QueryClientProvider>
      </App>
    </ConfigProvider>,
  );
  function enter() {
    fireEvent.doubleClick(screen.getByTestId('flow-process_text'));
  }
  async function refresh(items = f.executions) {
    tree.mockResolvedValue(f.page(items));
    await act(async () => {
      await cache.invalidateQueries({ queryKey: ['graph-execution-projection'] });
    });
  }
  return { ...f, cache, tree, view, enter, refresh };
}

function expectItem(index: number, status: string) {
  expect(document.querySelector(`[data-execution-instance="item-${index}"]`)).toBeTruthy();
  expect(
    screen.getByTestId('flow-generate').querySelector(`[data-runtime-status="${status}"]`),
  ).toBeTruthy();
}

async function chooseItem(label: string) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '选择 Item 执行' }));
  fireEvent.click(await screen.findByText(label, { selector: '.ant-select-item-option-content' }));
}

describe('Iteration Item Selector 的真实执行选择', () => {
  it('单 Item 自动解析，0 Item 保持 no_execution，均不要求 Selector', async () => {
    const f = mountIterationItems([2]);
    f.enter();
    await waitFor(() => expectItem(2, 'running'));
    expect(screen.queryByRole('combobox', { name: '选择 Item 执行' })).toBeNull();
    await f.refresh([]);
    await waitFor(() =>
      expect(document.querySelector('[data-execution-projection="no_execution"]')).toBeTruthy(),
    );
    expect(screen.queryByRole('combobox', { name: '选择 Item 执行' })).toBeNull();
    expect(document.querySelector('[data-execution-instance]')).toBeNull();
  });

  it('乱序多个 Item 默认最小 metadata.index，选项按真实 index 排序', async () => {
    const f = mountIterationItems([2, 0, 1]);
    f.enter();
    await waitFor(() => expectItem(0, 'completed'));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '选择 Item 执行' }));
    await screen.findByText('Item 3', { selector: '.ant-select-item-option-content' });
    expect(
      [...document.querySelectorAll('.ant-select-item-option-content')].map(
        (item) => item.textContent,
      ),
    ).toEqual(['Item 1', 'Item 2', 'Item 3']);
  });

  it('切换同名节点的 Item 后 Canvas / Inspector 同步切换 occurrence / attempt / status / 输出，不重新读取 Tree', async () => {
    const f = mountIterationItems();
    const first = f.itemRuns.find((record) => record.childExecutionId === 'item-0')!;
    first.attempt = 2;
    f.nodeRuns.push({
      ...first,
      id: 'old-item-0-attempt',
      attempt: 1,
      status: 'failed',
      outputs: { text: { storage: 'inline', type: StringType, value: '旧 Item 1 output' } },
    });
    f.itemRuns.find((record) => record.childExecutionId === 'item-1')!.attempt = 3;
    f.enter();
    await waitFor(() => expectItem(0, 'completed'));
    fireEvent.click(screen.getByTestId('flow-generate'));
    fireEvent.click(screen.getByRole('tab', { name: '运行状态' }));
    const inspector = screen.getByRole('complementary', { name: '节点检查器' });
    expect(within(inspector).getByText('Item 1 output')).toBeTruthy();
    fireEvent.click(within(inspector).getByRole('button', { name: 'Attempt 1' }));
    expect(within(inspector).getByText('旧 Item 1 output')).toBeTruthy();
    await chooseItem('Item 2');
    expectItem(1, 'failed');
    expect(inspector.querySelector('[data-runtime-status="failed"]')).toBeTruthy();
    expect(within(inspector).getByText('Item 2 output')).toBeTruthy();
    expect(within(inspector).queryByText('Item 1 output')).toBeNull();
    expect(within(inspector).queryByText('旧 Item 1 output')).toBeNull();
    await chooseItem('Item 3');
    expectItem(2, 'running');
    expect(inspector.querySelector('[data-runtime-status="running"]')).toBeTruthy();
    expect(within(inspector).getByText('Item 3 output')).toBeTruthy();
    expect(within(inspector).queryByText('Item 2 output')).toBeNull();
    expect(f.tree).toHaveBeenCalledOnce();
  });

  it('刷新保留仍存在的 executionId，返回父图再下钻也保留用户选择', async () => {
    const f = mountIterationItems();
    f.enter();
    await waitFor(() => expectItem(0, 'completed'));
    await chooseItem('Item 3');
    await f.refresh([...f.executions].reverse());
    expectItem(2, 'running');
    fireEvent.click(screen.getByRole('button', { name: '返回上一层' }));
    f.enter();
    await waitFor(() => expectItem(2, 'running'));
  });

  it('所选 executionId 消失后回退到最小 index，旧 ID 再出现也不抢走 fallback', async () => {
    const f = mountIterationItems();
    f.enter();
    await waitFor(() => expectItem(0, 'completed'));
    await chooseItem('Item 3');
    await f.refresh(f.executions.filter((entry) => entry.id !== 'item-2'));
    expectItem(0, 'completed');
    await f.refresh();
    expectItem(0, 'completed');
  });

  it('完整收集分页前保持 loading，不能把第一页的单 Item 提前当作唯一实例', async () => {
    const f = mountIterationItems();
    const next = deferred<ReturnType<typeof f.page>>();
    f.tree
      .mockResolvedValueOnce(f.page([f.executions[0]!], 'more'))
      .mockReturnValueOnce(next.promise);
    f.enter();
    await waitFor(() => expect(f.tree).toHaveBeenCalledTimes(2));
    expect(document.querySelector('[data-execution-projection="loading"]')).toBeTruthy();
    expect(document.querySelector('[data-execution-instance]')).toBeNull();
    expect(screen.queryByRole('combobox', { name: '选择 Item 执行' })).toBeNull();
    await act(async () => {
      next.resolve(f.page(f.executions.slice(1)));
    });
    await waitFor(() => expectItem(0, 'completed'));
    expect(screen.getByRole('combobox', { name: '选择 Item 执行' })).toBeTruthy();
    expect(f.tree.mock.calls[1]![1].after).toBe('more');
  });

  it('读取失败返回 unavailable 并撤下旧 Item 状态；metadata 无 index 时不按顺序猜测', async () => {
    const f = mountIterationItems();
    f.enter();
    await waitFor(() => expectItem(0, 'completed'));
    f.tree.mockRejectedValue(new Error('不可用'));
    await act(async () => {
      await f.cache.invalidateQueries({ queryKey: ['graph-execution-projection'] });
    });
    await waitFor(() =>
      expect(document.querySelector('[data-execution-projection="unavailable"]')).toBeTruthy(),
    );
    expect(document.querySelector('[data-execution-instance]')).toBeNull();
    expect(screen.queryByRole('combobox', { name: '选择 Item 执行' })).toBeNull();
    await f.refresh([{ ...f.executions[0]!, metadata: {} }]);
    expect(document.querySelector('[data-execution-projection="unavailable"]')).toBeTruthy();
    expect(
      await screen.findByText('Item 执行记录缺少有效且唯一的序号，暂时无法选择。'),
    ).toBeTruthy();
  });
});
