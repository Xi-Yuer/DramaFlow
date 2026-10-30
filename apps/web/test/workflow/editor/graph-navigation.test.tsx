// @vitest-environment happy-dom
import { createBuiltinNodeCatalogEntries } from '../../../../../packages/server/src/workflow/node/node-catalog';
import type { NodeCatalogEntry } from '@dramaflow/contracts';
import { createTestCatalogEntry } from '../../fixtures/node-catalog';
import { nodeCatalogKeys } from '../../../src/features/workflow/node-catalog/node-catalog-api';
import { useState } from 'react';
import { App, ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Edge, Node, ReactFlowProps, Viewport } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnyType,
  StringType,
  workflowDraftDefinitionSchema,
  workflowResponseSchema,
  nodeTypeManifestSchema,
  type NodeRun,
  type NodeTypeManifest,
  type WorkflowDefinition,
  type WorkflowResponse,
} from '@dramaflow/contracts';
import { GraphCanvasSession } from '../../../src/features/workflow/editor/navigation/graph-canvas-session';
import { workflowKeys } from '../../../src/features/workflow/workflow-api';
import { DRILL_MOTION_MS } from '../../../src/features/workflow/editor/navigation/graph-drill-transition';
import {
  createGraphNavigation,
  currentGraphLocation,
  editLocatedGraph,
  enterNestedGraph,
  graphLocationKey,
  isIterationBodyNode,
  jumpToGraph,
  patchGraphView,
  popGraph,
  readLocatedGraph,
  rootGraphLocation,
} from '../../../src/features/workflow/editor/navigation/graph-navigation';
import {
  fromReactFlowNode,
  toReactFlowNode,
} from '../../../src/features/workflow/canvas/adapter/node-adapter';
import { replaceNodeInput } from '../../../src/features/workflow/inputs/template/binding';
import { nodeTypeKeys } from '../../../src/features/workflow/node-catalog/node-type-api';
import { END_INPUT_HANDLE } from '../../../src/features/workflow/outputs/workflow-outputs';
import { resolveWorkflowNodePorts } from '../../../src/features/workflow/ports/resolve-workflow-node-ports';
import {
  createWorkflowDraftState,
  workflowDraftReducer,
  workflowDraftSignature,
} from '../../../src/features/workflow/editor/draft/workflow-draft-state';

let flow: ReactFlowProps<Node, Edge>;
let viewport: Viewport = { x: 0, y: 0, zoom: 1 };
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  useReactFlow: () => ({
    screenToFlowPosition: (point: unknown) => point,
    getViewport: () => viewport,
    setViewport: (next: Viewport) => {
      viewport = next;
    },
  }),
  ReactFlow: (props: ReactFlowProps<Node, Edge>) => {
    flow = props;
    return <div>画布</div>;
  },
}));

afterEach(() => {
  cleanup();
  viewport = { x: 0, y: 0, zoom: 1 };
});

const array = (itemType: typeof StringType | typeof AnyType) => ({
  kind: 'array' as const,
  itemType,
});

function manifest(input: unknown) {
  return nodeTypeManifestSchema.parse(input);
}

const textManifest = manifest({
  type: 'ai.text_generate',
  version: 1,
  executionKind: 'action',
  metadata: { name: '文本生成', category: 'ai' },
  inputs: [{ key: 'prompt', name: '提示词', dataType: StringType, required: true }],
  outputs: [{ key: 'text', name: '生成文本', dataType: StringType }],
  config: [],
});
const formatManifest = manifest({
  type: 'test.format_text',
  version: 1,
  executionKind: 'action',
  metadata: {
    name: '文本格式化',
    category: 'data',
  },
  inputs: [
    { key: 'text', name: '文本', dataType: StringType, required: true },
    { key: 'index', name: '序号', dataType: { kind: 'primitive', name: 'number' }, required: true },
  ],
  outputs: [{ key: 'text', name: '文本', dataType: StringType }],
  config: [],
});
const ifManifest = manifest({
  type: 'flow.if',
  version: 1,
  executionKind: 'control',
  metadata: {
    name: '条件分支',
    category: 'flow',
  },
  inputs: [{ key: 'value', name: '输入值', dataType: StringType, required: true }],
  outputs: [],
  controlOutputs: [
    { key: 'true', name: '条件成立' },
    { key: 'false', name: '条件不成立' },
  ],
  config: [],
});
const reviewManifest = manifest({
  type: 'flow.human_review',
  version: 1,
  executionKind: 'interaction',
  metadata: {
    name: '人工审批',
    category: 'flow',
  },
  inputs: [{ key: 'content', name: '待审核内容', dataType: StringType, required: true }],
  outputs: [{ key: 'content', name: '审核内容', dataType: StringType }],
  config: [],
});
const subworkflowManifest = manifest({
  type: 'flow.subworkflow',
  version: 1,
  executionKind: 'composite',
  portDerivation: 'subworkflow',
  metadata: {
    name: '子流程',
    category: 'flow',
  },
  inputs: [],
  outputs: [],
  config: [],
});
const iterationManifest = manifest({
  type: 'flow.iteration',
  version: 1,
  executionKind: 'composite',
  portDerivation: 'iteration',
  metadata: {
    name: '逐项处理',
    category: 'flow',
  },
  inputs: [{ key: 'items', name: '集合', dataType: array(AnyType), required: true }],
  outputs: [],
  config: [],
});
const controlActionManifest = manifest({
  type: 'test.gated',
  version: 1,
  executionKind: 'action',
  metadata: {
    name: '带控制出口',
    category: 'data',
  },
  inputs: [],
  outputs: [],
  controlOutputs: [{ key: 'done', name: '完成' }],
  config: [],
});
const publicActionManifest = {
  ...formatManifest,
  type: 'test.format',
  metadata: { name: '测试文本处理', category: 'data' as const },
};
const manifests = [
  publicActionManifest,
  textManifest,
  formatManifest,
  ifManifest,
  reviewManifest,
  iterationManifest,
  subworkflowManifest,
  controlActionManifest,
];

function node(
  id: string,
  type: NodeTypeManifest,
  name: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    type: type.type,
    typeVersion: type.version,
    name,
    inputs: {},
    config: {},
    ui: { position: { x: 0, y: 0 } },
    ...extra,
  };
}

function workflow(body = true): WorkflowDefinition {
  return {
    inputs: [],
    nodes: [
      node('format', textManifest, '根格式'),
      node(
        'iterate',
        iterationManifest,
        '逐项',
        body
          ? {
              composite: {
                kind: 'iteration',
                itemType: StringType,
                invariantInputs: [],
                bodyInputMapping: [],
                body: {
                  inputs: [],
                  nodes: [
                    node('format', formatManifest, '局部格式', {
                      ui: { position: { x: 5, y: 6 } },
                    }),
                  ],
                  edges: [],
                  outputs: [],
                },
              },
            }
          : {},
      ),
    ],
    edges: [
      {
        id: 'e1',
        kind: 'data',
        source: { nodeId: 'format', portKey: 'text' },
        target: { nodeId: 'iterate', portKey: 'items' },
      },
    ],
    outputs: [{ name: 'final', type: StringType, source: { nodeId: 'format', outputKey: 'text' } }],
  };
}

const rootRun: NodeRun = {
  id: 'run-1',
  workflowRunId: 'workflow-run',
  nodeId: 'format',
  occurrenceId: 'occurrence-1',
  scopeKey: 'root',
  attempt: 1,
  status: 'failed',
  error: { stage: 'execute', message: '根图失败标记' },
  startedAt: '2026-10-24T00:00:00.000Z',
  completedAt: '2026-10-24T00:00:01.000Z',
};

function bodyOf(definition: WorkflowDefinition) {
  const owner = definition.nodes.find((item) => item.id === 'iterate');
  if (owner?.composite?.kind !== 'iteration') throw new Error('缺少 body');
  return owner.composite.body;
}

function setup(initial = workflow(), catalogEntries?: readonly NodeCatalogEntry[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    nodeCatalogKeys.list,
    catalogEntries ?? [
      createTestCatalogEntry(textManifest),
      createTestCatalogEntry(publicActionManifest),
      createTestCatalogEntry(formatManifest, { exposure: 'internal' }),
      createTestCatalogEntry(ifManifest, { exposure: 'advanced' }),
      createTestCatalogEntry(reviewManifest),
      createTestCatalogEntry(iterationManifest, { exposure: 'internal' }),
      createTestCatalogEntry(subworkflowManifest, { exposure: 'internal' }),
      createTestCatalogEntry(controlActionManifest),
    ],
  );
  client.setQueryData(nodeTypeKeys.list, manifests);
  client.setQueryData(workflowKeys.version('navigation-version'), {
    id: 'navigation-version',
    workflowId: 'workflow',
    projectId: 'project',
    definition: structuredClone(initial),
  });
  const rootMoves: Viewport[] = [];
  let current = initial;
  function Editor() {
    const [definition, setDefinition] = useState(initial);
    current = definition;
    return (
      <GraphCanvasSession
        projectId="project"
        workflowId="workflow"
        workflow={definition}
        onEdit={(apply) => setDefinition((item) => apply(item))}
        onOpenProvider={() => undefined}
        reloading={false}
        initialRootViewport={{ x: 1, y: 2, zoom: 1 }}
        onRootViewportChange={(_, next) => {
          rootMoves.push(next);
        }}
        nodeRuns={[rootRun]}
        runStatus={{
          phase: 'ready',
          runId: rootRun.workflowRunId,
          run: {
            id: rootRun.workflowRunId,
            workflowId: 'workflow',
            workflowVersionId: 'navigation-version',
            invocationKey: 'navigation',
            status: 'failed',
            inputs: {},
            createdAt: rootRun.startedAt,
          },
          nodeRuns: [rootRun],
          error: null,
          refreshing: false,
          review: null,
        }}
      />
    );
  }
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <QueryClientProvider client={client}>
          <Editor />
        </QueryClientProvider>
      </App>
    </ConfigProvider>,
  );
  return {
    rootMoves,
    definition: () => current,
  };
}

function clickNode(id: string) {
  const node = flow.nodes?.find((item) => item.id === id);
  if (!node) throw new Error(`找不到节点 ${id}`);
  act(() => flow.onNodeClick?.({} as never, node));
}

function move(next: Viewport) {
  viewport = next;
  act(() => flow.onMoveEnd?.({} as never, next));
}

function flowNode(id: string) {
  return flow.nodes?.find((item) => item.id === id);
}

const bodyLocation = [{ nodeId: 'iterate', graphKey: 'body' as const }];

describe('图导航模型', () => {
  it('用栈记录 root 与 iteration body，不把父节点写进子图 nodeId', () => {
    const rootView = { x: 8, y: 9, zoom: 1.25 };
    let state = createGraphNavigation(rootView);
    state = patchGraphView(state, currentGraphLocation(state), {
      selectedNodeId: 'iterate',
      selectedEdgeIds: ['e1'],
    });
    state = enterNestedGraph(state, workflow(), 'iterate');
    expect(state.stack.map((layer) => layer.location)).toEqual([rootGraphLocation, bodyLocation]);
    expect(state.stack[1]?.label).toBe('逐项');
    expect(graphLocationKey(state.stack[1]!.location)).not.toContain('format');
    state = patchGraphView(state, currentGraphLocation(state), {
      selectedNodeId: 'format',
      viewport: { x: 3, y: 4, zoom: 2 },
    });
    state = popGraph(state);
    expect(currentGraphLocation(state)).toEqual(rootGraphLocation);
    expect(state.views.root).toMatchObject({
      selectedNodeId: 'iterate',
      selectedEdgeIds: ['e1'],
      viewport: rootView,
    });
    expect(state.views[graphLocationKey(state.stack[0]!.location)]?.viewport).toEqual(rootView);
    const bodyKey = graphLocationKey(bodyLocation);
    expect(state.views[bodyKey]).toMatchObject({
      selectedNodeId: 'format',
      viewport: { x: 3, y: 4, zoom: 2 },
    });
  });

  it('body 编辑只写 composite.body，同名节点和 root 输出互不影响', () => {
    const initial = workflow();
    const edited = workflowDraftDefinitionSchema.parse(
      editLocatedGraph(initial, bodyLocation, (graph) => {
        const withCaption = {
          ...graph,
          nodes: [
            ...graph.nodes,
            node('caption', textManifest, '旁白', { ui: { position: { x: 8, y: 8 } } }),
          ],
        };
        return replaceNodeInput(withCaption, 'format', 'text', {
          type: 'template',
          value: '局部 {{label}}',
          variables: { label: { type: 'node_output', nodeId: 'caption', portKey: 'text' } },
        });
      }),
    );
    expect(edited.nodes.find((item) => item.id === 'format')?.inputs).toEqual({});
    expect(edited.outputs).toEqual(initial.outputs);
    expect(bodyOf(edited).nodes.find((item) => item.id === 'format')?.inputs.text).toMatchObject({
      type: 'template',
      value: '局部 {{label}}',
    });
    expect(readLocatedGraph(edited, rootGraphLocation)?.outputs).toEqual(initial.outputs);
  });

  it('body 输出 text:string 成为父节点的 text:string[]', () => {
    const definition = workflow();
    const owner = definition.nodes.find((item) => item.id === 'iterate');
    if (owner?.composite?.kind !== 'iteration') throw new Error('缺少 Iteration');
    owner.composite.body.outputs = [
      { name: 'text', type: StringType, source: { nodeId: 'format', outputKey: 'text' } },
    ];
    expect(resolveWorkflowNodePorts(owner, iterationManifest).outputs).toEqual([
      { key: 'text', name: 'text', dataType: array(StringType) },
    ]);
  });

  it('Body 能力过滤精确加入 SubWorkflow v1', () => {
    expect(manifests.filter(isIterationBodyNode).map((item) => item.type)).toEqual([
      'test.format',
      'ai.text_generate',
      'test.format_text',
      'flow.subworkflow',
    ]);
  });
});

describe('Iteration Body 画布', () => {
  it('在 root 与 body 之间切换，并隔离同名节点、选择、视口和测量', async () => {
    const view = setup();
    expect(flow.defaultViewport).toEqual({ x: 1, y: 2, zoom: 1 });
    expect(flowNode('format')?.data).toMatchObject({ name: '根格式' });
    expect(document.querySelector('[data-graph-location="root"]')).toBeTruthy();

    clickNode('format');
    fireEvent.click(screen.getByRole('tab', { name: '运行状态' }));
    expect(screen.getByText('根图失败标记')).toBeTruthy();
    expect(document.querySelector('[data-runtime-status="failed"]')).toBeTruthy();

    clickNode('iterate');
    act(() => flow.onEdgesChange?.([{ type: 'select', id: 'e1', selected: true }]));
    act(() =>
      flow.onNodesChange?.([
        { id: 'format', type: 'dimensions', dimensions: { width: 180, height: 72 } },
      ] as never),
    );
    expect(flowNode('format')?.measured).toEqual({ width: 180, height: 72 });
    move({ x: 12, y: 18, zoom: 1.2 });
    expect(view.rootMoves).toEqual([{ x: 12, y: 18, zoom: 1.2 }]);

    fireEvent.click(screen.getByRole('button', { name: '编辑 Body' }));
    const trail = screen.getByRole('navigation', { name: '图位置' });
    expect(trail.textContent).toContain('主流程');
    expect(trail.textContent).toContain('逐项');
    expect(trail.textContent).not.toContain('Body');
    expect(trail.textContent).not.toContain('iterate');
    expect(document.querySelector('[data-graph-location="body"]')).toBeTruthy();
    expect(flow.defaultViewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(flowNode('format')?.data).toMatchObject({ name: '局部格式' });
    expect(flowNode('format')?.measured).toBeUndefined();
    expect(flowNode('format')?.selected).toBeFalsy();
    expect(flowNode('iterate')).toBeUndefined();
    expect(flow.edges?.some((edge) => edge.id === 'e1')).toBe(false);

    clickNode('format');
    expect(screen.queryByText('根图失败标记')).toBeNull();
    expect(document.querySelector('[data-runtime-status="failed"]')).toBeNull();
    expect(document.querySelector('[data-runtime-status="idle"]')).toBeTruthy();
    move({ x: 4, y: 5, zoom: 2 });
    expect(view.rootMoves).toEqual([{ x: 12, y: 18, zoom: 1.2 }]);

    fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
    expect(await screen.findByRole('button', { name: '添加 文本生成 · v1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加 测试文本处理 · v1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '添加 文本格式化 · v1' })).toBeNull();
    expect(screen.queryByRole('button', { name: '添加 条件分支 · v1' })).toBeNull();
    expect(screen.queryByRole('button', { name: '添加 人工审批 · v1' })).toBeNull();
    expect(screen.queryByRole('button', { name: '添加 逐项处理 · v1' })).toBeNull();
    expect(screen.queryByRole('button', { name: '添加 带控制出口 · v1' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '添加 测试文本处理 · v1' }));
    fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
    fireEvent.click(await screen.findByRole('button', { name: '添加 文本生成 · v1' }));

    const addedFormat = bodyOf(view.definition()).nodes.find((item) => item.type === 'test.format');
    const addedText = bodyOf(view.definition()).nodes.find(
      (item) => item.type === 'ai.text_generate',
    );
    expect(addedFormat).toBeTruthy();
    expect(addedText).toBeTruthy();

    act(() =>
      flow.onNodesChange?.([
        { id: 'format', type: 'position', position: { x: 30, y: 40 }, dragging: false },
      ]),
    );
    expect(
      bodyOf(view.definition()).nodes.find((item) => item.id === 'format')?.ui.position,
    ).toEqual({
      x: 30,
      y: 40,
    });
    expect(view.definition().nodes.find((item) => item.id === 'format')?.ui.position).toEqual({
      x: 0,
      y: 0,
    });

    act(() =>
      flow.onConnect?.({
        source: 'format',
        sourceHandle: 'text',
        target: addedText!.id,
        targetHandle: 'prompt',
      }),
    );
    expect(bodyOf(view.definition()).edges).toEqual([
      expect.objectContaining({
        kind: 'data',
        source: { nodeId: 'format', portKey: 'text' },
        target: { nodeId: addedText!.id, portKey: 'prompt' },
      }),
    ]);
    expect(view.definition().edges).toHaveLength(1);

    const end = flow.nodes?.find((item) => item.type === 'workflowEnd');
    act(() =>
      flow.onConnect?.({
        source: 'format',
        sourceHandle: 'text',
        target: end!.id,
        targetHandle: END_INPUT_HANDLE,
      }),
    );
    expect(bodyOf(view.definition()).outputs).toEqual([
      {
        name: 'result',
        type: StringType,
        source: { nodeId: 'format', outputKey: 'text' },
      },
    ]);
    expect(view.definition().outputs).toEqual(workflow().outputs);

    act(() => flow.onNodesChange?.([{ id: addedText!.id, type: 'remove' }]));
    expect(
      bodyOf(view.definition())
        .nodes.map((item) => item.id)
        .sort(),
    ).toEqual(['format', addedFormat!.id].sort());
    expect(bodyOf(view.definition()).edges).toEqual([]);
    expect(view.definition().nodes.map((item) => item.id)).toEqual(['format', 'iterate']);

    expect(
      resolveWorkflowNodePorts(
        view.definition().nodes.find((item) => item.id === 'iterate')!,
        iterationManifest,
      ).outputs,
    ).toEqual([{ key: 'result', name: 'result', dataType: array(StringType) }]);

    fireEvent.click(screen.getByRole('button', { name: '返回上一层' }));
    expect(document.querySelector('[data-graph-location="root"]')).toBeTruthy();
    expect(flow.defaultViewport).toEqual({ x: 12, y: 18, zoom: 1.2 });
    expect(flowNode('iterate')?.selected).toBe(true);
    expect(flow.edges?.find((edge) => edge.id === 'e1')?.selected).toBe(true);
    expect(flowNode('format')?.data).toMatchObject({ name: '根格式' });
    expect(flowNode('format')?.measured).toBeUndefined();
    clickNode('format');
    fireEvent.click(screen.getByRole('tab', { name: '运行状态' }));
    // Body 已被编辑，旧版本的运行事实不能继续覆盖当前 Draft。
    expect(screen.queryByText('根图失败标记')).toBeNull();
    expect(document.querySelector('[data-execution-projection="version_mismatch"]')).toBeTruthy();
    expect(
      resolveWorkflowNodePorts(
        view.definition().nodes.find((item) => item.id === 'iterate')!,
        iterationManifest,
      ).outputs[0]?.dataType,
    ).toEqual(array(StringType));

    const snapshot = workflowDraftDefinitionSchema.parse(
      JSON.parse(JSON.stringify(view.definition())),
    );
    const saved = workflowDraftReducer(
      {
        ...createWorkflowDraftState({
          id: 'workflow-1',
          projectId: 'project-1',
          revision: 1,
          draft: workflow(),
        } as WorkflowResponse),
        definition: snapshot,
        savedSignature: workflowDraftSignature(workflow()),
      },
      { type: 'save-succeeded', revision: 2, snapshot },
    );
    const reloaded = workflowDraftReducer(saved, {
      type: 'reload-succeeded',
      workflow: {
        id: 'workflow-1',
        projectId: 'project-1',
        revision: 2,
        draft: snapshot,
      } as WorkflowResponse,
    });
    expect(reloaded.definition.outputs).toEqual(workflow().outputs);
    expect(
      bodyOf(reloaded.definition)
        .nodes.map((item) => item.name)
        .sort(),
    ).toEqual(['局部格式', '测试文本处理'].sort());
    expect(bodyOf(reloaded.definition).outputs[0]).toMatchObject({
      name: 'result',
      source: { nodeId: 'format', outputKey: 'text' },
    });
    expect(reloaded.revision).toBe(2);
  });

  it('没有 composite.body 的 Iteration 不能进入', () => {
    setup(workflow(false));
    clickNode('iterate');
    expect(screen.getByRole('button', { name: '编辑 Body' })).toHaveProperty('disabled', true);
    expect(screen.getByText('尚未配置 Body')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '编辑 Body' }));
    expect(screen.queryByRole('navigation', { name: '图位置' })).toBeNull();
    expect(document.querySelector('[data-graph-location="root"]')).toBeTruthy();
  });
});

function graphOf(nodes: WorkflowDefinition['nodes']): WorkflowDefinition {
  return { inputs: [], nodes, edges: [], outputs: [] };
}

function subworkflowNode(id: string, name: string, childName: string) {
  return node(id, subworkflowManifest, name, {
    composite: {
      kind: 'subworkflow',
      graph: graphOf([
        node('format', formatManifest, childName, { ui: { position: { x: 4, y: 5 } } }),
      ]),
    },
  });
}

function nestedWorkflow(): WorkflowDefinition {
  return {
    inputs: [],
    nodes: [
      node('format', textManifest, '根格式'),
      node('iterate', iterationManifest, '单集生成', {
        composite: {
          kind: 'iteration',
          itemType: StringType,
          invariantInputs: [],
          bodyInputMapping: [],
          body: graphOf([
            node('format', formatManifest, '局部格式'),
            subworkflowNode('call', '分镜生成', '子格式'),
          ]),
        },
      }),
    ],
    edges: [],
    outputs: [],
  };
}

describe('多层 Definition Location', () => {
  it('按完整路径解析和更新，同层之外的同名 nodeId 保持不变', () => {
    const initial = nestedWorkflow();
    const inner = [
      { nodeId: 'iterate', graphKey: 'body' as const },
      { nodeId: 'call', graphKey: 'graph' as const },
    ];
    expect(readLocatedGraph(initial, [{ nodeId: 'call', graphKey: 'graph' }])).toBeNull();
    expect(readLocatedGraph(initial, inner)?.nodes.map((item) => item.name)).toEqual(['子格式']);
    const edited = editLocatedGraph(initial, inner, (graph) => ({
      ...graph,
      nodes: graph.nodes.map((item) =>
        item.id === 'format' ? { ...item, name: '已改子格式' } : item,
      ),
    }));
    expect(edited.nodes.find((item) => item.id === 'format')?.name).toBe('根格式');
    expect(bodyOf(edited).nodes.find((item) => item.id === 'format')?.name).toBe('局部格式');
    expect(readLocatedGraph(edited, inner)?.nodes[0]?.name).toBe('已改子格式');
    const call = bodyOf(edited).nodes.find((item) => item.id === 'call');
    expect(fromReactFlowNode(toReactFlowNode(call)).composite).toEqual(call?.composite);
  });

  it('进入、返回和 breadcrumb 跳转后恢复各层选择与视口', () => {
    const definition = nestedWorkflow();
    let state = createGraphNavigation({ x: 1, y: 1, zoom: 1 });
    state = enterNestedGraph(state, definition, 'iterate');
    state = patchGraphView(state, currentGraphLocation(state), {
      selectedNodeId: 'call',
      viewport: { x: 2, y: 3, zoom: 1.5 },
    });
    state = enterNestedGraph(state, definition, 'call');
    const inner = currentGraphLocation(state);
    state = patchGraphView(state, inner, {
      selectedNodeId: 'format',
      selectedEdgeIds: ['inner'],
      viewport: { x: 9, y: 8, zoom: 3 },
    });
    state = jumpToGraph(state, 0);
    expect(currentGraphLocation(state)).toEqual(rootGraphLocation);
    expect(state.views[graphLocationKey(bodyLocation)]).toMatchObject({ selectedNodeId: 'call' });
    state = enterNestedGraph(state, definition, 'iterate');
    expect(state.views[graphLocationKey(currentGraphLocation(state))]?.viewport).toEqual({
      x: 2,
      y: 3,
      zoom: 1.5,
    });
    state = enterNestedGraph(state, definition, 'call');
    expect(state.views[graphLocationKey(currentGraphLocation(state))]).toMatchObject({
      selectedNodeId: 'format',
      selectedEdgeIds: ['inner'],
      viewport: { x: 9, y: 8, zoom: 3 },
    });
  });
});

describe('SubWorkflow 画布', () => {
  it('独立 public Entry 可创建 internal Runtime 类型的内嵌图，名称与 identity 来自 Entry', async () => {
    const entry = createTestCatalogEntry(subworkflowManifest, {
      id: 'fixture-composite-entry',
      metadata: { name: '测试组合入口' },
      creation: {
        composite: {
          kind: 'subworkflow',
          graph: graphOf([node('format', formatManifest, '预配置内部节点')]),
        },
      },
    });
    const view = setup(graphOf([]), [entry]);
    fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
    fireEvent.click(await screen.findByRole('button', { name: '添加 测试组合入口 · v1' }));
    const created = view.definition().nodes[0]!;
    expect(created).toMatchObject({
      type: 'flow.subworkflow',
      typeVersion: 1,
      name: '测试组合入口',
    });
    expect(created).not.toHaveProperty('entryId');
    expect(created.composite).toEqual(entry.creation.composite);
    expect(created.composite).not.toBe(entry.creation.composite);
    expect(flowNode(created.id)?.selected).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '进入' }));
    expect(flowNode('format')?.data).toMatchObject({ name: '预配置内部节点' });
    expect(document.querySelector('[data-graph-location="graph"]')).toBeTruthy();
  });

  it('进入子图后编辑写回根 Definition，并恢复视口与选择', () => {
    const view = setup({
      inputs: [],
      nodes: [
        node('format', textManifest, '根格式'),
        subworkflowNode('call', '分镜生成', '子格式'),
      ],
      edges: [],
      outputs: [],
    });
    fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
    expect(screen.queryByRole('button', { name: '添加 子流程 · v1' })).toBeNull();
    expect(screen.queryByRole('button', { name: '添加 逐项处理 · v1' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
    clickNode('call');
    fireEvent.click(screen.getByRole('button', { name: '进入' }));
    expect(document.querySelector('[data-graph-location="graph"]')).toBeTruthy();
    const trail = screen.getByRole('navigation', { name: '图位置' });
    expect(trail.textContent).toContain('主流程');
    expect(trail.textContent).toContain('分镜生成');
    expect(trail.textContent).not.toContain('graph');
    expect(trail.textContent).not.toContain('call');
    expect(flowNode('format')?.data).toMatchObject({ name: '子格式' });
    expect(screen.queryByText('根图失败标记')).toBeNull();

    clickNode('format');
    move({ x: 6, y: 7, zoom: 1.4 });
    act(() =>
      flow.onNodesChange?.([
        { id: 'format', type: 'position', position: { x: 11, y: 12 }, dragging: false },
      ]),
    );
    const child = view.definition().nodes.find((item) => item.id === 'call');
    if (child?.composite?.kind !== 'subworkflow') throw new Error('缺少子图');
    expect(child.composite.graph.nodes.find((item) => item.id === 'format')?.ui.position).toEqual({
      x: 11,
      y: 12,
    });
    expect(view.definition().nodes.find((item) => item.id === 'format')?.ui.position).toEqual({
      x: 0,
      y: 0,
    });

    fireEvent.click(screen.getByRole('button', { name: '返回上一层' }));
    expect(document.querySelector('[data-graph-location="root"]')).toBeTruthy();
    expect(flowNode('call')?.selected).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '进入' }));
    expect(flow.defaultViewport).toEqual({ x: 6, y: 7, zoom: 1.4 });
    expect(flowNode('format')?.selected).toBe(true);
    const snapshot = workflowDraftDefinitionSchema.parse(
      JSON.parse(JSON.stringify(view.definition())),
    );
    const saved = workflowDraftReducer(
      {
        ...createWorkflowDraftState({
          id: 'workflow-1',
          projectId: 'project-1',
          revision: 1,
          draft: snapshot,
        } as WorkflowResponse),
        definition: snapshot,
      },
      { type: 'save-succeeded', revision: 2, snapshot },
    );
    const reloaded = workflowDraftReducer(saved, {
      type: 'reload-succeeded',
      workflow: {
        id: 'workflow-1',
        projectId: 'project-1',
        revision: 2,
        draft: snapshot,
      } as WorkflowResponse,
    });
    expect(reloaded.definition).toEqual(view.definition());
    expect(reloaded.definition.nodes.find((item) => item.id === 'call')?.composite).toEqual(
      child.composite,
    );
    expect(reloaded.revision).toBe(2);
  });

  it('breadcrumb 可以回到任意中间层', () => {
    const view = setup(nestedWorkflow());
    clickNode('iterate');
    fireEvent.click(screen.getByRole('button', { name: '编辑 Body' }));
    clickNode('call');
    fireEvent.click(screen.getByRole('button', { name: '进入' }));
    const trail = screen.getByRole('navigation', { name: '图位置' }).textContent;
    expect(trail).toContain('主流程');
    expect(trail).toContain('单集生成');
    expect(trail).toContain('分镜生成');
    fireEvent.click(screen.getByRole('button', { name: '单集生成' }));
    expect(document.querySelector('[data-graph-location="body"]')).toBeTruthy();
    expect(flowNode('format')?.data).toMatchObject({ name: '局部格式' });
    expect(flowNode('call')?.selected).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '主流程' }));
    expect(document.querySelector('[data-graph-location="root"]')).toBeTruthy();
    expect(flowNode('iterate')?.selected).toBe(true);
    expect(view.definition().nodes.map((item) => item.id)).toEqual(['format', 'iterate']);
  });
});

function box(left: number, top: number, width: number, height: number): () => DOMRect {
  return () =>
    ({
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    }) as DOMRect;
}

function placeOwnerAnchor(id: string) {
  const stage = document.querySelector('.canvas-stage');
  if (!stage) throw new Error('找不到画布');
  stage.getBoundingClientRect = box(0, 0, 800, 600);
  const owner = document.createElement('div');
  owner.className = 'react-flow__node';
  owner.dataset.id = id;
  owner.getBoundingClientRect = box(100, 80, 180, 72);
  stage.appendChild(owner);
}

async function settleDrill() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, DRILL_MOTION_MS + 60));
  });
}

describe('空间化进入与返回', () => {
  it('有锚点时先锁定交互，动画结束后才允许返回', async () => {
    setup();
    clickNode('iterate');
    move({ x: 12, y: 18, zoom: 1.2 });
    placeOwnerAnchor('iterate');
    fireEvent.click(screen.getByRole('button', { name: '编辑 Body' }));
    expect(document.querySelector('[data-graph-location="body"]')).toBeTruthy();
    expect(document.querySelector('[data-drill="enter"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回上一层' }));
    expect(document.querySelector('[data-graph-location="body"]')).toBeTruthy();
    await settleDrill();
    expect(document.querySelector('[data-drill]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '返回上一层' }));
    expect(document.querySelector('[data-drill="exit"]')).toBeTruthy();
    expect(document.querySelector('[data-graph-location="body"]')).toBeTruthy();
    await settleDrill();
    expect(document.querySelector('[data-graph-location="root"]')).toBeTruthy();
    expect(flow.defaultViewport).toEqual({ x: 12, y: 18, zoom: 1.2 });
    expect(flowNode('iterate')?.selected).toBe(true);
  });

  it('reduced motion 或没有锚点时直接完成导航', () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    setup();
    clickNode('iterate');
    placeOwnerAnchor('iterate');
    fireEvent.click(screen.getByRole('button', { name: '编辑 Body' }));
    expect(document.querySelector('[data-drill]')).toBeNull();
    expect(document.querySelector('[data-graph-location="body"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回上一层' }));
    expect(document.querySelector('[data-graph-location="root"]')).toBeTruthy();
    window.matchMedia = original;
  });
});

it('正式 Body Picker → 子流程 Entry → graph 编辑 → Draft save/read', async () => {
  const entries = createBuiltinNodeCatalogEntries();
  const view = setup(workflow(), entries);
  clickNode('iterate');
  fireEvent.click(screen.getByRole('button', { name: '编辑 Body' }));
  fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
  fireEvent.click(await screen.findByRole('button', { name: '添加 子流程 · v1' }));
  const created = bodyOf(view.definition()).nodes.find((node) => node.type === 'flow.subworkflow')!;
  expect(created.composite).toEqual({
    kind: 'subworkflow',
    graph: { inputs: [], nodes: [], edges: [], outputs: [] },
  });
  fireEvent.click(screen.getByRole('button', { name: '进入' }));
  expect(document.querySelector('[data-graph-location="graph"]')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
  expect(screen.queryByRole('button', { name: '添加 子流程 · v1' })).toBeNull();
  expect(screen.queryByRole('button', { name: '添加 人工审批 · v1' })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: '添加 文本生成 · v1' }));
  const snapshot = workflowDraftDefinitionSchema.parse(
    JSON.parse(JSON.stringify(view.definition())),
  );
  const response = workflowResponseSchema.parse({
    metadataRevision: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    id: 'workflow',
    projectId: '00000000-0000-4000-8000-000000000001',
    name: '默认工作流',
    revision: 1,
    draft: snapshot,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
  });
  let state = workflowDraftReducer(createWorkflowDraftState(response), {
    type: 'save-succeeded',
    revision: 2,
    snapshot,
  });
  state = workflowDraftReducer(state, {
    type: 'reload-succeeded',
    workflow: { ...response, revision: 2, draft: snapshot },
  });
  const location = [
    { nodeId: 'iterate', graphKey: 'body' as const },
    { nodeId: created.id, graphKey: 'graph' as const },
  ];
  expect(readLocatedGraph(state.definition, location)?.nodes[0]?.type).toBe('ai.text_generate');
  expect(entries.find((entry) => entry.id === 'subworkflow')?.creation.composite).toEqual(
    created.composite,
  );
});
