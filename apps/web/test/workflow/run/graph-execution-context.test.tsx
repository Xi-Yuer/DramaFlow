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
import type { WorkflowVersionResponse } from '@dramaflow/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGraphExecutionProjection } from '../../../src/features/workflow/runtime/use-graph-execution-projection';
import { workflowApi, workflowKeys } from '../../../src/features/workflow/workflow-api';
import { graphExecutionFixture } from '../../fixtures/graph-execution';
import { GraphCanvasSession } from '../../../src/features/workflow/editor/navigation/graph-canvas-session';
import { nodeCatalogKeys } from '../../../src/features/workflow/node-catalog/node-catalog-api';
import { nodeTypeKeys } from '../../../src/features/workflow/node-catalog/node-type-api';
import { createSubworkflowNodeType } from '../../../../../packages/workflow/src/node/builtin/subworkflow';
import { createTextGenerationNodeType } from '../../../../../packages/workflow/src/node/builtin/text-generation';
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
