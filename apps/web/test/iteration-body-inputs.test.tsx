// @vitest-environment happy-dom
import { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App, ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowProps,
} from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnyType,
  NumberType,
  StringType,
  nodeTypeManifestSchema,
  workflowDraftDefinitionSchema,
  type NodeDefinition,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import {
  disconnectWorkflowEdge,
  toReactFlowEdges,
  toReactFlowNode,
  type WorkflowNode,
} from '../src/features/workflow/canvas/react-flow-adapter';
import {
  GenericWorkflowNode,
  WorkflowManifestProvider,
} from '../src/features/workflow/canvas/workflow-node';
import { GraphCanvasSession } from '../src/features/workflow/editor/graph-canvas-session';
import { WorkflowBodyInputs } from '../src/features/workflow/iteration/body-input-boundary-node';
import {
  projectBodyInputBoundary,
  type WorkflowBodyInputNode,
} from '../src/features/workflow/iteration/body-input-boundary';
import { workflowApi } from '../src/features/workflow/workflow-api';
import {
  addBodyInput,
  addInvariantInput,
  bindGraphInput,
  bodyInputSourceOptions,
  initializeIterationBody,
  removeBodyInput,
  removeInvariantInput,
  setBodyInputMapping,
  setIterationItemType,
  updateBodyInput,
  updateInvariantInput,
} from '../src/features/workflow/iteration/iteration-body-inputs';
import { nodeTypeKeys } from '../src/features/workflow/node-catalog/node-type-api';
import { setWorkflowOutput } from '../src/features/workflow/outputs/workflow-outputs';
import { resolveWorkflowNodePorts } from '../src/features/workflow/ports/resolve-workflow-node-ports';

let flow: ReactFlowProps<Node, Edge>;
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  useReactFlow: () => ({
    screenToFlowPosition: (point: unknown) => point,
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    setViewport: () => undefined,
  }),
  ReactFlow: (props: ReactFlowProps<Node, Edge>) => {
    flow = props;
    return <div>画布</div>;
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const array = (itemType: typeof StringType | typeof NumberType) => ({
  kind: 'array' as const,
  itemType,
});

function manifest(input: unknown) {
  return nodeTypeManifestSchema.parse(input);
}

const formatManifest = manifest({
  type: 'data.format_text',
  version: 1,
  executionKind: 'action',
  metadata: { name: '文本格式化', category: 'data' },
  inputs: [
    { key: 'text', name: '文本', dataType: StringType, required: true },
    { key: 'index', name: '序号', dataType: NumberType, required: true },
  ],
  outputs: [{ key: 'text', name: '文本', dataType: StringType }],
  config: [
    {
      key: 'template',
      name: '格式模板',
      type: 'string',
      required: true,
      defaultValue: '{{text}}-{{index}}',
    },
  ],
});
const iterationManifest = manifest({
  type: 'flow.iteration',
  version: 1,
  executionKind: 'composite',
  portDerivation: 'iteration',
  metadata: { name: '逐项处理', category: 'flow' },
  inputs: [
    { key: 'items', name: '集合', dataType: { kind: 'array', itemType: AnyType }, required: true },
  ],
  outputs: [],
  config: [],
});
const manifests = [formatManifest, iterationManifest];

function iteration(extra: Record<string, unknown> = {}): NodeDefinition {
  return {
    id: 'iterate',
    type: 'flow.iteration',
    typeVersion: 1,
    name: '逐项',
    inputs: {},
    config: {},
    ui: { position: { x: 0, y: 0 } },
    ...extra,
  } as NodeDefinition;
}

function formatNode(inputs: NodeDefinition['inputs'] = {}): NodeDefinition {
  return {
    id: 'format',
    type: 'data.format_text',
    typeVersion: 1,
    name: '格式化',
    inputs,
    config: { template: '{{text}}-{{index}}' },
    ui: { position: { x: 20, y: 30 } },
  };
}

function withFormat(node: NodeDefinition, inputs: NodeDefinition['inputs'] = {}): NodeDefinition {
  if (node.composite?.kind !== 'iteration') throw new Error('缺少 Body');
  return {
    ...node,
    composite: {
      ...node.composite,
      body: { ...node.composite.body, nodes: [formatNode(inputs)] },
    },
  };
}

function card(node: NodeDefinition) {
  const flowNode = toReactFlowNode(node);
  const props: NodeProps<WorkflowNode> = {
    id: flowNode.id,
    type: 'workflowNode',
    data: flowNode.data,
    selected: false,
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: true,
    draggable: true,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <WorkflowManifestProvider manifests={manifests}>
        <GenericWorkflowNode {...props} />
      </WorkflowManifestProvider>
    </ReactFlowProvider>,
  );
}

describe('Iteration Body 输入编辑', () => {
  it('初始化空壳且不创建 Action', () => {
    const node = initializeIterationBody(iteration());
    expect(node.composite).toMatchObject({
      kind: 'iteration',
      itemType: StringType,
      invariantInputs: [],
      bodyInputMapping: [],
      body: { inputs: [], nodes: [], edges: [], outputs: [] },
    });
    expect(initializeIterationBody(node)).toBe(node);
  });

  it('增删改 Body 输入，并同步 mapping 与 workflow_input', () => {
    let node = initializeIterationBody(iteration());
    node = addBodyInput(node);
    node = addBodyInput(node);
    node = updateBodyInput(node, 'input', { name: 'text' }, manifests);
    node = updateBodyInput(node, 'input_2', { name: 'index', type: NumberType }, manifests);
    node = setBodyInputMapping(node, 'text', { type: 'current_item' });
    node = setBodyInputMapping(node, 'index', { type: 'current_index' });
    node = withFormat(node, {
      text: { type: 'workflow_input', key: 'text' },
      index: {
        type: 'template',
        value: '序号 {{label}}',
        variables: { label: { type: 'workflow_input', key: 'index' } },
      },
    });
    expect(node.composite?.body.inputs).toEqual([
      { name: 'text', type: StringType, required: true },
      { name: 'index', type: NumberType, required: true },
    ]);
    expect(node.composite?.bodyInputMapping).toEqual([
      { target: 'text', source: { type: 'current_item' } },
      { target: 'index', source: { type: 'current_index' } },
    ]);

    node = updateBodyInput(node, 'text', { name: 'copy' }, manifests);
    expect(node.composite?.bodyInputMapping[0]).toEqual({
      target: 'copy',
      source: { type: 'current_item' },
    });
    expect(node.composite?.body.nodes[0]?.inputs.text).toEqual({
      type: 'workflow_input',
      key: 'copy',
    });

    node = updateBodyInput(node, 'index', { name: 'nth' }, manifests);
    expect(node.composite?.body.nodes[0]?.inputs.index).toEqual({
      type: 'template',
      value: '序号 {{label}}',
      variables: { label: { type: 'workflow_input', key: 'nth' } },
    });

    node = updateBodyInput(node, 'copy', { type: NumberType }, manifests);
    expect(node.composite?.bodyInputMapping.map((item) => item.target)).toEqual(['nth']);
    expect(node.composite?.body.nodes[0]?.inputs.text).toBeUndefined();

    node = removeBodyInput(node, 'nth');
    expect(node.composite?.bodyInputMapping).toEqual([]);
    expect(node.composite?.body.nodes[0]?.inputs.index).toEqual({
      type: 'constant',
      value: '序号',
    });
    expect(node.composite?.body.inputs.map((input) => input.name)).toEqual(['copy']);
    node = updateBodyInput(node, 'copy', { required: false });
    expect(node.composite?.body.inputs[0]?.required).toBe(false);
    node = withFormat(node, { text: { type: 'workflow_input', key: 'copy' } });
    node = removeBodyInput(node, 'copy');
    expect(node.composite?.body.nodes[0]?.inputs.text).toBeUndefined();
    expect(() => updateBodyInput(node, 'missing', { name: 'other' })).toThrow(/不存在/);
    node = addBodyInput(node);
    node = addBodyInput(node);
    expect(() => updateBodyInput(node, 'input_2', { name: 'input' })).toThrow(/重复/);
  });

  it('按 DataType 过滤来源，重复 target 会被替换', () => {
    let node = initializeIterationBody(iteration());
    node = addInvariantInput(node);
    node = updateInvariantInput(node, 'input', { name: 'index' });
    node = addBodyInput(node);
    node = updateBodyInput(node, 'input', { name: 'value', type: NumberType });
    expect(bodyInputSourceOptions(node.composite!, NumberType).map((option) => option.id)).toEqual([
      'current_index',
    ]);
    node = updateBodyInput(node, 'value', { type: StringType });
    expect(bodyInputSourceOptions(node.composite!, StringType).map((option) => option.id)).toEqual([
      'current_item',
      'iteration_input:index',
    ]);
    node = setIterationItemType(node, array(StringType));
    node = updateBodyInput(node, 'value', { type: array(StringType) });
    expect(
      bodyInputSourceOptions(node.composite!, array(StringType)).some(
        (option) => option.id === 'current_item',
      ),
    ).toBe(true);
    node = updateBodyInput(node, 'value', { type: StringType });
    expect(
      bodyInputSourceOptions(node.composite!, StringType).some(
        (option) => option.id === 'current_item',
      ),
    ).toBe(false);

    node = setIterationItemType(node, StringType);
    node = setBodyInputMapping(node, 'value', { type: 'current_item' });
    node = setBodyInputMapping(node, 'value', { type: 'iteration_input', key: 'index' });
    expect(node.composite?.bodyInputMapping).toEqual([
      { target: 'value', source: { type: 'iteration_input', key: 'index' } },
    ]);
    expect(() => setBodyInputMapping(node, 'value', { type: 'current_index' })).toThrow(/不兼容/);
    node = updateBodyInput(node, 'value', { required: false });
    expect(node.composite?.body.inputs[0]?.required).toBe(false);
    expect(node.composite?.bodyInputMapping).toHaveLength(1);
  });

  it('不变输入增删改会更新父端口和映射', () => {
    let node = initializeIterationBody(iteration());
    node = addBodyInput(node);
    node = updateBodyInput(node, 'input', { name: 'style' });
    node = addInvariantInput(node);
    node = updateInvariantInput(node, 'input', { name: 'style' });
    node = setBodyInputMapping(node, 'style', { type: 'iteration_input', key: 'style' });
    expect(resolveWorkflowNodePorts(node, iterationManifest).inputs).toEqual([
      { key: 'items', name: '集合', dataType: array(StringType), required: true },
      { key: 'style', name: 'style', dataType: StringType, required: true },
    ]);
    expect(card(node)).toContain('data-handleid="style"');
    expect(card(node)).toContain('data-handleid="items"');

    node = updateInvariantInput(node, 'style', { name: 'tone' });
    expect(node.composite?.bodyInputMapping).toEqual([
      { target: 'style', source: { type: 'iteration_input', key: 'tone' } },
    ]);
    expect(() => updateInvariantInput(node, 'tone', { name: 'items' })).toThrow(/items/);
    expect(
      resolveWorkflowNodePorts(node, iterationManifest).inputs.map((port) => port.key),
    ).toEqual(['items', 'tone']);

    node = updateInvariantInput(node, 'tone', { type: NumberType });
    expect(node.composite?.bodyInputMapping).toEqual([]);
    node = setIterationItemType(node, NumberType);
    node = updateBodyInput(node, 'style', { type: NumberType });
    node = setBodyInputMapping(node, 'style', { type: 'iteration_input', key: 'tone' });
    node = removeInvariantInput(node, 'tone');
    expect(node.composite?.bodyInputMapping).toEqual([]);
    expect(card(node)).not.toContain('data-handleid="tone"');
    expect(card(node)).toContain('data-handleid="items"');
  });

  it('Body 输入边界只投影 workflow_input，不写 DataEdge', () => {
    let node = initializeIterationBody(iteration());
    node = addBodyInput(node);
    node = updateBodyInput(node, 'input', { name: 'text' });
    node = addBodyInput(node);
    node = updateBodyInput(node, 'input', { name: 'index', type: NumberType });
    node = withFormat(node, {});
    const body = node.composite!.body;
    const bound = bindGraphInput(body, manifests, 'format', 'text', 'text');
    expect(bound.edges).toEqual([]);
    expect(bound.nodes[0]?.inputs.text).toEqual({ type: 'workflow_input', key: 'text' });
    expect(toReactFlowEdges(bound).some((edge) => edge.data?.projection === 'workflow-input')).toBe(
      false,
    );
    const projected = projectBodyInputBoundary(bound);
    expect(bound.nodes.map((item) => item.id)).not.toContain(projected.node.id);
    expect(bound.edges).toEqual([]);
    expect(projected.node.data.inputs.map((input) => input.name)).toEqual(['text', 'index']);
    expect(projected.edges).toEqual([
      expect.objectContaining({
        source: projected.node.id,
        sourceHandle: 'text',
        target: 'format',
        targetHandle: 'text',
        data: { kind: 'data', projection: 'workflow-input' },
      }),
    ]);
    const removed = disconnectWorkflowEdge(bound, projected.edges[0]);
    expect(removed.nodes[0]?.inputs.text).toBeUndefined();
    expect(removed.edges).toEqual([]);
    expect(() => bindGraphInput(bound, manifests, 'format', 'text', 'index')).toThrow(/不兼容/);

    const markup = renderToStaticMarkup(
      <ReactFlowProvider>
        <WorkflowBodyInputs
          id={projected.node.id}
          type="workflowBodyInputs"
          data={projected.node.data}
          selected={false}
          dragging={false}
          zIndex={0}
          selectable
          deletable={false}
          draggable
          isConnectable
          positionAbsoluteX={0}
          positionAbsoluteY={0}
        />
      </ReactFlowProvider>,
    );
    expect(markup).toContain('text');
    expect(markup).toContain('index');
    expect(markup).not.toContain('current_item');
    expect(markup).not.toContain('当前元素');
  });

  it('父节点动态输出保持数组，复合定义可往返', () => {
    let node = withFormat(initializeIterationBody(iteration()));
    if (node.composite?.kind !== 'iteration') throw new Error('缺少 Body');
    node = {
      ...node,
      composite: {
        ...node.composite,
        body: {
          ...node.composite.body,
          outputs: [
            { name: 'text', type: StringType, source: { nodeId: 'format', outputKey: 'text' } },
          ],
        },
      },
    };
    node = addBodyInput(node);
    node = updateBodyInput(node, 'input', { name: 'text' });
    node = setBodyInputMapping(node, 'text', { type: 'current_item' });
    expect(node.composite?.body.outputs).toEqual([
      { name: 'text', type: StringType, source: { nodeId: 'format', outputKey: 'text' } },
    ]);
    expect(resolveWorkflowNodePorts(node, iterationManifest).outputs).toEqual([
      { key: 'text', name: 'text', dataType: array(StringType) },
    ]);

    const named = setWorkflowOutput(
      node.composite!.body,
      { name: 'text', source: { nodeId: 'format', outputKey: 'text' } },
      manifests,
      'text',
    );
    const definition = workflowDraftDefinitionSchema.parse({
      inputs: [{ name: 'items', type: array(StringType), required: true }],
      nodes: [
        {
          ...node,
          inputs: { items: { type: 'workflow_input', key: 'items' } },
          composite: {
            ...node.composite,
            bodyInputMapping: [
              { target: 'text', source: { type: 'current_item' } },
              { target: 'index', source: { type: 'current_index' } },
            ],
            body: {
              ...named,
              inputs: [
                { name: 'text', type: StringType, required: true },
                { name: 'index', type: NumberType, required: true },
              ],
              nodes: [
                formatNode({
                  text: { type: 'workflow_input', key: 'text' },
                  index: { type: 'workflow_input', key: 'index' },
                }),
              ],
            },
          },
        },
      ],
      edges: [],
      outputs: [
        {
          name: 'result',
          type: array(StringType),
          source: { nodeId: 'iterate', outputKey: 'text' },
        },
      ],
    });
    const reloaded = workflowDraftDefinitionSchema.parse(JSON.parse(JSON.stringify(definition)));
    expect(reloaded.nodes[0]?.composite).toEqual(definition.nodes[0]?.composite);
    expect(reloaded.nodes[0]?.inputs.items).toEqual({ type: 'workflow_input', key: 'items' });
    expect(resolveWorkflowNodePorts(reloaded.nodes[0]!, iterationManifest).outputs[0]).toEqual({
      key: 'text',
      name: 'text',
      dataType: array(StringType),
    });
  });
});

describe('Iteration Inspector 与 Body 画布', () => {
  function setup(
    initial: WorkflowDefinition = {
      inputs: [],
      nodes: [iteration()],
      edges: [],
      outputs: [],
    },
  ) {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    client.setQueryData(nodeTypeKeys.list, manifests);
    let current = initial;
    function Editor() {
      const [definition, setDefinition] = useState(initial);
      current = definition;
      return (
        <GraphCanvasSession
          projectId="project"
          workflow={definition}
          onEdit={(apply) => setDefinition((item) => apply(item))}
          onOpenProvider={() => undefined}
          reloading={false}
          initialRootViewport={{ x: 0, y: 0, zoom: 1 }}
          onRootViewportChange={() => undefined}
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
    return { definition: () => current };
  }

  function owner(definition: WorkflowDefinition) {
    const node = definition.nodes.find((item) => item.id === 'iterate');
    if (node?.composite?.kind !== 'iteration') throw new Error('缺少 Iteration');
    return node;
  }

  it('Root 数组声明 → Iteration → Body 输入和输出 → Draft HTTP 保存回读', async () => {
    const view = setup();
    const rootBoundary = flow.nodes!.find(
      (node) => node.type === 'workflowBodyInputs',
    )! as WorkflowBodyInputNode;
    expect(rootBoundary.data.scope).toBe('root');
    act(() => rootBoundary.data.onConfigure?.());
    fireEvent.click(screen.getByRole('button', { name: '添加 工作流输入' }));
    const typeSelect = screen.getByRole('combobox', {
      name: '工作流输入类型 input',
    }) as HTMLSelectElement;
    expect([...typeSelect.options].map((option) => option.text)).toEqual([
      '文本',
      '数字',
      '布尔',
      '文本列表',
      '数字列表',
    ]);
    fireEvent.change(typeSelect, { target: { value: 'string[]' } });
    fireEvent.change(screen.getByRole('textbox', { name: '工作流输入名称 input' }), {
      target: { value: 'items' },
    });
    fireEvent.blur(screen.getByRole('textbox', { name: '工作流输入名称 input' }));
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(view.definition().inputs).toEqual([
      { name: 'items', type: array(StringType), required: true },
    ]);
    act(() =>
      flow.onNodeClick?.(
        {} as never,
        flow.nodes!.find((node) => node.id === 'iterate')!,
      ),
    );
    expect(screen.getByRole('button', { name: '编辑 Body' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '初始化 Body' }));
    expect(screen.getByRole('button', { name: '编辑 Body' })).toHaveProperty('disabled', false);
    expect(owner(view.definition()).composite?.body.nodes).toEqual([]);
    const rootConnection = {
      source: rootBoundary.id,
      sourceHandle: 'items',
      target: 'iterate',
      targetHandle: 'items',
    };
    expect(flow.isValidConnection?.(rootConnection)).toBe(true);
    act(() => flow.onConnect?.(rootConnection));
    expect(owner(view.definition()).inputs.items).toEqual({ type: 'workflow_input', key: 'items' });
    expect(view.definition().edges).toEqual([]);
    const rootProjection = flow.edges!.find((edge) => edge.data?.projection === 'workflow-input')!;
    act(() => flow.onEdgesDelete?.([rootProjection]));
    expect(owner(view.definition()).inputs.items).toBeUndefined();
    act(() => flow.onConnect?.(rootConnection));

    fireEvent.click(screen.getByRole('button', { name: '添加 Body 输入' }));
    expect(screen.getAllByRole('status').some((item) => item.textContent?.includes('未配置'))).toBe(
      true,
    );
    const stringSources = screen.getByRole('combobox', {
      name: 'input 的来源',
    }) as HTMLSelectElement;
    expect([...stringSources.options].map((option) => option.text)).toContain('← 当前元素');
    expect([...stringSources.options].map((option) => option.text)).not.toContain('← 当前序号');
    fireEvent.change(stringSources, { target: { value: 'current_item' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Body 输入名称 input' }), {
      target: { value: 'text' },
    });
    fireEvent.blur(screen.getByRole('textbox', { name: 'Body 输入名称 input' }));

    fireEvent.click(screen.getByRole('button', { name: '添加 Body 输入' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Body 输入类型 input' }), {
      target: { value: 'number' },
    });
    const numberSources = screen.getByRole('combobox', {
      name: 'input 的来源',
    }) as HTMLSelectElement;
    expect([...numberSources.options].map((option) => option.text)).toContain('← 当前序号');
    expect([...numberSources.options].map((option) => option.text)).not.toContain('← 当前元素');
    fireEvent.change(numberSources, { target: { value: 'current_index' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Body 输入名称 input' }), {
      target: { value: 'index' },
    });
    fireEvent.blur(screen.getByRole('textbox', { name: 'Body 输入名称 input' }));

    fireEvent.click(screen.getByRole('button', { name: '添加 不变输入' }));
    fireEvent.change(screen.getByRole('textbox', { name: '不变输入名称 input' }), {
      target: { value: 'style' },
    });
    fireEvent.blur(screen.getByRole('textbox', { name: '不变输入名称 input' }));
    expect(resolveWorkflowNodePorts(owner(view.definition()), iterationManifest).inputs).toEqual([
      expect.objectContaining({ key: 'items', dataType: array(StringType) }),
      expect.objectContaining({ key: 'style', dataType: StringType }),
    ]);
    expect(card(owner(view.definition()))).toContain('data-handleid="style"');

    expect(owner(view.definition()).composite?.bodyInputMapping).toEqual([
      { target: 'text', source: { type: 'current_item' } },
      { target: 'index', source: { type: 'current_index' } },
    ]);

    fireEvent.click(screen.getByRole('button', { name: '编辑 Body' }));
    const boundary = flow.nodes?.find((node) => node.type === 'workflowBodyInputs');
    expect(boundary?.data).toMatchObject({
      inputs: [
        { name: 'text', type: StringType, required: true },
        { name: 'index', type: NumberType, required: true },
      ],
    });
    expect(JSON.stringify(boundary?.data)).not.toContain('current_item');

    fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
    fireEvent.click(await screen.findByRole('button', { name: '添加 文本格式化 · v1' }));
    const format = owner(view.definition()).composite?.body.nodes.find(
      (node) => node.type === 'data.format_text',
    );
    expect(format?.config).toEqual({ template: '{{text}}-{{index}}' });
    expect(
      flow.isValidConnection?.({
        source: boundary!.id,
        sourceHandle: 'index',
        target: format!.id,
        targetHandle: 'text',
      }),
    ).toBe(false);
    act(() => {
      flow.onConnect?.({
        source: boundary!.id,
        sourceHandle: 'text',
        target: format!.id,
        targetHandle: 'text',
      });
      flow.onConnect?.({
        source: boundary!.id,
        sourceHandle: 'index',
        target: format!.id,
        targetHandle: 'index',
      });
    });
    const body = owner(view.definition()).composite!.body;
    expect(body.edges).toEqual([]);
    expect(body.nodes[0]?.inputs).toEqual({
      text: { type: 'workflow_input', key: 'text' },
      index: { type: 'workflow_input', key: 'index' },
    });
    const projection = flow.edges?.filter((edge) => edge.data?.projection === 'workflow-input');
    expect(projection?.map((edge) => [edge.sourceHandle, edge.targetHandle])).toEqual([
      ['text', 'text'],
      ['index', 'index'],
    ]);
    act(() => flow.onEdgesDelete?.([projection![0]!]));
    expect(owner(view.definition()).composite?.body.nodes[0]?.inputs.text).toBeUndefined();
    expect(owner(view.definition()).composite?.body.edges).toEqual([]);
    expect(flow.edges?.some((edge) => edge.sourceHandle === 'text' && edge.data?.projection)).toBe(
      false,
    );
    act(() =>
      flow.onConnect?.({
        source: boundary!.id,
        sourceHandle: 'text',
        target: format!.id,
        targetHandle: 'text',
      }),
    );

    const end = flow.nodes?.find((node) => node.type === 'workflowEnd');
    act(() =>
      flow.onConnect?.({
        source: format!.id,
        sourceHandle: 'text',
        target: end!.id,
        targetHandle: 'workflow-output',
      }),
    );
    expect(resolveWorkflowNodePorts(owner(view.definition()), iterationManifest).outputs).toEqual([
      { key: 'result', name: 'result', dataType: array(StringType) },
    ]);
    const saved = workflowDraftDefinitionSchema.parse(
      JSON.parse(JSON.stringify(view.definition())),
    );
    expect(saved.nodes[0]?.composite?.bodyInputMapping).toEqual([
      { target: 'text', source: { type: 'current_item' } },
      { target: 'index', source: { type: 'current_index' } },
    ]);
    expect(saved.nodes[0]?.composite?.body.inputs.map((input) => input.name)).toEqual([
      'text',
      'index',
    ]);
    expect(saved.nodes[0]?.composite?.invariantInputs.map((input) => input.name)).toEqual([
      'style',
    ]);

    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ revision: 2 }));
    vi.stubGlobal('fetch', fetch);
    await workflowApi.saveDraft('workflow', { expectedRevision: 1, definition: view.definition() });
    const request = JSON.parse(fetch.mock.calls[0]![1].body as string);
    expect(request.definition).toEqual(saved);
    expect(request.definition.nodes.map((node: NodeDefinition) => node.id)).toEqual(['iterate']);
    expect(request.definition.edges).toEqual([]);
    const projectId = '7ac10b00-33cc-4e50-9a2b-05ef764c44f4';
    fetch.mockResolvedValueOnce(
      Response.json({
        id: 'workflow',
        projectId,
        name: '数组输入验收',
        revision: 2,
        draft: request.definition,
        createdAt: '2026-10-26T00:00:00.000Z',
        updatedAt: '2026-10-26T00:00:00.000Z',
      }),
    );
    const loaded = (await workflowApi.get(projectId)).draft;
    expect(fetch).toHaveBeenCalledTimes(2);
    cleanup();
    setup(loaded);
    const reopenedBoundary = flow.nodes!.find((node) => node.type === 'workflowBodyInputs')!;
    expect(reopenedBoundary.data.inputs).toEqual(saved.inputs);
    expect(flow.edges!.find((edge) => edge.data?.projection === 'workflow-input')).toMatchObject({
      source: reopenedBoundary.id,
      sourceHandle: 'items',
      target: 'iterate',
      targetHandle: 'items',
    });
    expect(resolveWorkflowNodePorts(loaded.nodes[0]!, iterationManifest).outputs).toEqual([
      { key: 'result', name: 'result', dataType: array(StringType) },
    ]);
  });
});
