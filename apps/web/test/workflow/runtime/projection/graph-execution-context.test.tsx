// @vitest-environment happy-dom
import {
  NodeRegistry,
  validateWorkflowForPublish,
} from '../../../../../../packages/workflow/src/index';
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
import { useGraphExecutionSelection } from '../../../../src/features/workflow/runtime/projection/use-graph-execution-selection';
import { useGraphExecutionProjection } from '../../../../src/features/workflow/runtime/projection/use-graph-execution-projection';
import { workflowApi, workflowKeys } from '../../../../src/features/workflow/workflow-api';
import {
  graphExecutionFixture,
  iterationExecutionFixture,
  iterationSubworkflowExecutionFixture,
} from '../../../fixtures/graph-execution';
import { GraphCanvasSession } from '../../../../src/features/workflow/editor/navigation/graph-canvas-session';
import { nodeCatalogKeys } from '../../../../src/features/workflow/node-catalog/node-catalog-api';
import { nodeTypeKeys } from '../../../../src/features/workflow/node-catalog/node-type-api';
import { createSubworkflowNodeType } from '../../../../../../packages/workflow/src/node/builtin/subworkflow';
import { createTextGenerationNodeType } from '../../../../../../packages/workflow/src/node/builtin/text-generation';
import { createIterationNodeType } from '../../../../../../packages/workflow/src/node/builtin/iteration';
import { GenericWorkflowNode } from '../../../../src/features/workflow/canvas/rendering/workflow-node';
import {
  fromReactFlowNode,
  toReactFlowNode,
} from '../../../../src/features/workflow/canvas/adapter/node-adapter';

vi.mock('../../../../src/features/auth/use-identity', () => ({
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

function mountIterationItems(indexes = [2, 0, 1], nested = false) {
  const nestedFixture = nested ? iterationSubworkflowExecutionFixture() : undefined;
  const f = nestedFixture ?? iterationExecutionFixture(indexes);
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
  });
  cache.setQueryData(workflowKeys.version(f.version.id), f.version);
  cache.setQueryData(nodeCatalogKeys.list, []);
  cache.setQueryData(nodeTypeKeys.list, [
    createIterationNodeType().manifest,
    createSubworkflowNodeType().manifest,
    createTextGenerationNodeType().manifest,
  ]);
  const tree = vi
    .spyOn(workflowApi, 'getExecutionTree')
    .mockImplementation(async (_run, query) =>
      nestedFixture
        ? nestedFixture.treePage(query.parentId ?? f.parentRun.id)
        : f.page(f.executions),
    );
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

  it('所选 executionId 消失后不映射其他 Item，重新明确选择后保持新 ID', async () => {
    const f = mountIterationItems();
    f.enter();
    await waitFor(() => expectItem(0, 'completed'));
    await chooseItem('Item 3');
    await f.refresh(f.executions.filter((entry) => entry.id !== 'item-2'));
    await waitFor(() =>
      expect(document.querySelector('[data-execution-projection="unavailable"]')).toBeTruthy(),
    );
    expect(document.querySelector('[data-execution-instance]')).toBeNull();
    expect(screen.getByText('请选择 Item')).toBeTruthy();
    await chooseItem('Item 2');
    expectItem(1, 'failed');
    await f.refresh();
    expectItem(1, 'failed');
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

describe('祖先 Item selection 的更深层 projection', () => {
  function enterSub() {
    fireEvent.doubleClick(screen.getByTestId('flow-sub'));
  }
  function back() {
    fireEvent.click(screen.getByRole('button', { name: '返回上一层' }));
  }
  function expectAction(index: number, status: string) {
    expect(document.querySelector(`[data-execution-instance="sub-item-${index}"]`)).toBeTruthy();
    expect(
      screen.getByTestId('flow-action').querySelector(`[data-runtime-status="${status}"]`),
    ).toBeTruthy();
  }
  function inspect() {
    fireEvent.click(screen.getByTestId('flow-action'));
    fireEvent.click(screen.getByRole('tab', { name: '运行状态' }));
    return screen.getByRole('complementary', { name: '节点检查器' });
  }

  it('Item 2 → SubWorkflow 保持真实 ChildExecution，切换祖先后 Canvas / Inspector 不串同名 action', async () => {
    const f = mountIterationItems(undefined, true);
    const inner = f.workflow.nodes[0]!.composite;
    if (inner?.kind !== 'iteration' || inner.body.nodes[0]?.composite?.kind !== 'subworkflow')
      throw new Error('缺少正式 graph');
    inner.body.nodes[0].composite.graph.nodes[0]!.config.modelConfigurationId =
      '00000000-0000-4000-8000-000000000001';
    f.version.definition = structuredClone(f.workflow);
    f.cache.setQueryData(workflowKeys.version(f.version.id), f.version);
    expect(() =>
      validateWorkflowForPublish(
        f.workflow,
        new NodeRegistry([
          createIterationNodeType(),
          createSubworkflowNodeType(),
          createTextGenerationNodeType(),
        ]),
      ),
    ).not.toThrow();
    const action = f.nodeRuns.find((record) => record.childExecutionId === 'sub-item-1')!;
    action.attempt = 3;
    f.nodeRuns.push({
      ...action,
      id: 'old-action-attempt',
      attempt: 1,
      outputs: { text: { storage: 'inline', type: StringType, value: 'Old action output' } },
    });
    f.enter();
    await screen.findByRole('combobox', { name: '选择 Item 执行' });
    await chooseItem('Item 2');
    enterSub();
    await waitFor(() => expectAction(1, 'failed'));
    let inspector = inspect();
    expect(inspector.querySelector('[data-runtime-status="failed"]')).toBeTruthy();
    expect(within(inspector).getByText('Action item-1 output')).toBeTruthy();
    expect(within(inspector).getByText('Error item-1')).toBeTruthy();
    expect(within(inspector).getByRole('button', { name: 'Attempt 3' })).toBeTruthy();
    fireEvent.click(within(inspector).getByRole('button', { name: 'Attempt 1' }));
    expect(within(inspector).getByText('Old action output')).toBeTruthy();
    expect(f.tree).toHaveBeenCalledTimes(2);
    back();
    await chooseItem('Item 3');
    enterSub();
    await waitFor(() => expectAction(2, 'running'));
    inspector = inspect();
    expect(inspector.querySelector('[data-runtime-status="running"]')).toBeTruthy();
    expect(within(inspector).getByText('Action item-2 output')).toBeTruthy();
    expect(within(inspector).queryByText('Action item-1 output')).toBeNull();
    expect(within(inspector).queryByText('Error item-1')).toBeNull();
    expect(within(inspector).queryByText('Old action output')).toBeNull();
    expect(within(inspector).queryByRole('button', { name: 'Attempt 3' })).toBeNull();
    expect(f.tree).toHaveBeenCalledTimes(3);
    back();
    await chooseItem('Item 2');
    enterSub();
    await waitFor(() => expectAction(1, 'failed'));
    expect(f.tree).toHaveBeenCalledTimes(3);
    back();
    back();
    f.enter();
    enterSub();
    await waitFor(() => expectAction(1, 'failed'));
    expect(f.tree).toHaveBeenCalledTimes(3);
  });

  it('深层刷新保留有效 ancestor ID；ID 消失则撤下旧状态，不映射另一 Item', async () => {
    const f = mountIterationItems(undefined, true);
    f.enter();
    await screen.findByRole('combobox', { name: '选择 Item 执行' });
    await chooseItem('Item 2');
    enterSub();
    await waitFor(() => expectAction(1, 'failed'));
    await act(async () => {
      await f.cache.invalidateQueries({ queryKey: ['graph-execution-projection'] });
    });
    await waitFor(() => expectAction(1, 'failed'));
    expect(f.tree).toHaveBeenCalledTimes(4);
    f.executions.splice(
      f.executions.findIndex((item) => item.id === 'item-1'),
      1,
    );
    await act(async () => {
      await f.cache.invalidateQueries({ queryKey: ['graph-execution-projection'] });
    });
    await waitFor(() =>
      expect(document.querySelector('[data-execution-projection="unavailable"]')).toBeTruthy(),
    );
    expect(document.querySelector('[data-execution-instance]')).toBeNull();
    expect(f.tree).toHaveBeenCalledTimes(5);
    back();
    expect(screen.getByText('请选择 Item')).toBeTruthy();
    await chooseItem('Item 1');
    enterSub();
    await waitFor(() => expectAction(0, 'completed'));
    expect(f.tree).toHaveBeenCalledTimes(6);
  });

  it('旧 Item 的迟到 Tree 响应不能覆盖新祖先下的 descendant', async () => {
    const data = iterationSubworkflowExecutionFixture();
    const pending = deferred<ReturnType<typeof data.treePage>>();
    const f = mountIterationItems(undefined, true);
    f.tree.mockImplementation(async (_run, query) =>
      query.parentId === 'item-node-run-1'
        ? pending.promise
        : data.treePage(query.parentId ?? data.parentRun.id),
    );
    f.enter();
    await screen.findByRole('combobox', { name: '选择 Item 执行' });
    await chooseItem('Item 2');
    enterSub();
    await waitFor(() => expect(f.tree).toHaveBeenCalledTimes(2));
    expect(document.querySelector('[data-execution-projection="loading"]')).toBeTruthy();
    back();
    await chooseItem('Item 3');
    enterSub();
    await waitFor(() => expectAction(2, 'running'));
    await act(async () => {
      pending.resolve(data.treePage('item-node-run-1'));
    });
    expectAction(2, 'running');
    const inspector = inspect();
    expect(within(inspector).getByText('Action item-2 output')).toBeTruthy();
    expect(within(inspector).queryByText('Action item-1 output')).toBeNull();
    expect(f.tree).toHaveBeenCalledTimes(3);
  });

  it('统一 selection store 在祖先改变时清除后代，同 ID 重选与其他 Run/版本独立', () => {
    const f = iterationSubworkflowExecutionFixture();
    const parentInstance = { type: 'workflow_run' as const, id: f.run.id };
    const parent = {
      workflowRunId: f.run.id,
      definition: { workflowVersionId: f.version.id, path: f.location },
      parentInstance,
      parentNodeRunId: f.parentRun.id,
      candidates: f.executions.map((item) => ({
        executionId: item.id,
        kind: item.kind,
        metadata: item.metadata,
      })),
    };
    const descendant = {
      ...parent,
      definition: { ...parent.definition, path: f.descendant },
      parentInstance: { type: 'child_execution' as const, id: 'item-1' },
      parentNodeRunId: 'item-node-run-1',
      candidates: [{ executionId: 'sub-item-1', kind: 'subworkflow', metadata: {} }],
    };
    const view = renderHook(useGraphExecutionSelection);
    act(() => view.result.current.select(parent, 'item-1'));
    act(() => view.result.current.select(descendant, 'sub-item-1'));
    act(() => view.result.current.select(parent, 'item-1'));
    expect(view.result.current.choices).toHaveLength(2);
    act(() => view.result.current.select({ ...parent, workflowRunId: 'other-run' }, 'item-0'));
    act(() =>
      view.result.current.select(
        { ...parent, definition: { ...parent.definition, workflowVersionId: 'other-version' } },
        'item-0',
      ),
    );
    act(() => view.result.current.select(parent, 'item-2'));
    expect(view.result.current.choices.map((choice) => choice.executionId)).toEqual([
      'item-0',
      'item-0',
      'item-2',
    ]);
  });
});
