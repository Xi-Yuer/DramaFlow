// @vitest-environment happy-dom
import { nodeCatalogKeys } from '../src/features/workflow/node-catalog/node-catalog-api';
import { useContext, useEffect, useState } from 'react';
import { App, ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Node, Edge, ReactFlowProps } from '@xyflow/react';
import type { WorkflowDefinition } from '@dramaflow/contracts';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowCanvas } from '../src/features/workflow/canvas/workflow-canvas';
import { nodeTypeKeys } from '../src/features/workflow/node-catalog/node-type-api';
import { WorkflowInputContext } from '../src/features/workflow/inputs/workflow-input-context';
import { TemplateInputEditor } from '../src/features/workflow/inputs/template-input-editor';
import { availableStringOutputs } from '../src/features/workflow/inputs/template-input';
import { templateWorkflow, templateManifest } from './fixtures/template-input';

let flow: ReactFlowProps<Node, Edge>;
let definition: WorkflowDefinition;
function TargetInput() {
  const actions = useContext(WorkflowInputContext)!;
  return (
    <TemplateInputEditor
      portName="提示词"
      binding={actions.definition.nodes.find((node) => node.id === 'c')!.inputs.prompt}
      connected={false}
      definition={actions.definition}
      manifests={actions.manifests}
      outputs={availableStringOutputs(actions.definition, 'c', actions.manifests)}
      disabled={actions.disabled}
      onChange={(binding) => actions.onReplaceInput('c', 'prompt', binding)}
    />
  );
}
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  useReactFlow: () => ({ screenToFlowPosition: (point: unknown) => point }),
  ReactFlow: (props: ReactFlowProps<Node, Edge>) => {
    flow = props;
    return <TargetInput />;
  },
}));
afterEach(cleanup);
function setup(initial = templateWorkflow()) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(nodeCatalogKeys.list, []);
  client.setQueryData(nodeTypeKeys.list, [templateManifest]);
  function Editor() {
    const [workflow, setWorkflow] = useState(initial);
    useEffect(() => {
      definition = workflow;
    }, [workflow]);
    return (
      <WorkflowCanvas
        projectId="project"
        workflow={workflow}
        onEdit={setWorkflow}
        onOpenProvider={() => {}}
        reloading={false}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        onMoveEnd={() => {}}
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
}
const projections = () => flow.edges!.filter((edge) => edge.data?.projection === 'template-input');

describe('模板引用与 Canvas 自动同步', () => {
  it('插入变量自动生成数据依赖线，删除最后引用移除投影，全程不创建真实 DataEdge', async () => {
    const initial = templateWorkflow();
    initial.nodes[2]!.inputs = {};
    setup(initial);
    expect(projections()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '向提示词插入变量' }));
    fireEvent.click(await screen.findByRole('option', { name: 'b 生成文本' }));
    expect(definition.nodes[2]!.inputs.prompt).toEqual({
      type: 'template',
      value: '{{text}}',
      variables: { text: { type: 'node_output', nodeId: 'b', portKey: 'text' } },
    });
    expect(projections()).toHaveLength(1);
    expect(projections()[0]).toMatchObject({
      source: 'b',
      sourceHandle: 'text',
      target: 'c',
      targetHandle: 'prompt',
    });
    expect(definition.edges).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '删除变量 b 生成文本' }));
    expect(definition.nodes[2]!.inputs.prompt).toBeUndefined();
    expect(projections()).toEqual([]);
    expect(definition.edges).toEqual([]);
  });
  it('已有两个 alias 指向同 source 时只显示一条线，逐个删变量后才移除依赖', () => {
    const initial = templateWorkflow();
    const binding = initial.nodes[2]!.inputs.prompt!;
    if (binding.type !== 'template') throw new Error('fixture');
    binding.variables.characters = { ...binding.variables.outline! };
    setup(initial);
    expect(projections()).toHaveLength(1);
    fireEvent.click(screen.getAllByRole('button', { name: '删除变量 a 生成文本' })[0]!);
    expect(projections()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '删除变量 a 生成文本' }));
    expect(projections()).toEqual([]);
    expect(definition.nodes[2]!.inputs.prompt).toEqual({ type: 'constant', value: '根据   继续' });
    expect(definition.edges).toEqual([]);
  });
  it('删节点经过领域 cleanup 自动移除模板引用；投影不允许直接删线或拖动重连', () => {
    setup();
    expect(projections()).toHaveLength(2);
    const projection = projections()[0]!;
    const snapshot = structuredClone(definition);
    expect(projection.deletable).toBe(false);
    expect(projection.reconnectable).toBe(false);
    act(() => flow.onEdgesDelete!([projection]));
    expect(definition).toEqual(snapshot);
    act(() =>
      flow.onReconnect!(projection, {
        source: 'b',
        sourceHandle: 'text',
        target: 'c',
        targetHandle: 'prompt',
      }),
    );
    expect(definition).toEqual(snapshot);
    act(() => flow.onNodesChange!([{ type: 'remove', id: 'a' }]));
    expect(projections().map((edge) => edge.source)).toEqual(['b']);
    const binding = definition.nodes.find((node) => node.id === 'c')!.inputs.prompt!;
    expect(binding).toEqual({
      type: 'template',
      value: '根据  {{characters}} 继续',
      variables: { characters: { type: 'node_output', nodeId: 'b', portKey: 'text' } },
    });
  });
});
