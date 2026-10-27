// @vitest-environment happy-dom
import { nodeCatalogKeys } from '../src/features/workflow/node-catalog/node-catalog-api';
import { useState } from 'react';
import { App, ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Node, Edge, ReactFlowProps } from '@xyflow/react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from '@dramaflow/contracts';
import { WorkflowCanvas } from '../src/features/workflow/canvas/workflow-canvas';
import { nodeTypeKeys } from '../src/features/workflow/node-catalog/node-type-api';
import { candidateConnection, candidateWorkflow } from './fixtures/candidate-input';
import { ifCatalog, ifWorkflow } from './fixtures/workflow-if';

let flow: ReactFlowProps<Node, Edge>;
let saved: WorkflowDefinition;
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  useReactFlow: () => ({ screenToFlowPosition: (point: unknown) => point }),
  ReactFlow: (props: ReactFlowProps<Node, Edge>) => {
    flow = props;
    return <div>画布</div>;
  },
}));
afterEach(cleanup);
function setup(initial = ifWorkflow()) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(nodeCatalogKeys.list, []);
  client.setQueryData(nodeTypeKeys.list, ifCatalog);
  function Editor() {
    const [workflow, setWorkflow] = useState(initial);
    saved = workflow;
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
const connect = (source = 'b') => act(() => flow.onConnect!({ ...candidateConnection, source }));
const projections = () => flow.edges!.filter((edge) => edge.data?.projection === 'candidate-input');

describe('候选输入 Canvas 确认交互', () => {
  it('第二条连接可取消、明确添加候选，删除投影或 source node 后保留候选编辑态', async () => {
    setup();
    connect('a');
    const single = saved;
    connect();
    expect(screen.getAllByText('该输入已有数据来源')).toHaveLength(2);
    expect(saved).toBe(single);
    fireEvent.click(screen.getByRole('button', { name: '取 消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(saved).toBe(single);
    connect();
    fireEvent.click(screen.getByRole('radio', { name: '添加为候选来源' }));
    fireEvent.click(screen.getByRole('button', { name: '确 认' }));
    await waitFor(() => expect(projections()).toHaveLength(2));
    expect(saved.nodes[3]!.inputs.prompt).toEqual(candidateWorkflow().nodes[3]!.inputs.prompt);
    expect(saved.edges).toEqual([]);
    act(() => flow.onEdgesDelete!([projections()[0]!]));
    expect(saved.nodes[3]!.inputs.prompt).toEqual({
      type: 'candidate',
      sources: [{ type: 'node_output', nodeId: 'b', portKey: 'text' }],
    });
    expect(projections()).toHaveLength(1);
    act(() => flow.onNodesChange!([{ type: 'remove', id: 'b' }]));
    expect(saved.nodes.find((node) => node.id === 'c')!.inputs.prompt).toBeUndefined();
    expect(projections()).toHaveLength(0);
  });
  it('第二条连接也可以明确替换，只保留一个普通 DataEdge', async () => {
    setup();
    connect('a');
    connect();
    fireEvent.click(screen.getByRole('radio', { name: '替换现有来源' }));
    fireEvent.click(screen.getByRole('button', { name: '确 认' }));
    await waitFor(() => expect(saved.edges[0]!.source.nodeId).toBe('b'));
    expect(saved.edges).toHaveLength(1);
    expect(saved.nodes[3]!.inputs.prompt).toBeUndefined();
    expect(projections()).toEqual([]);
  });
  it('已有 Draft 立即显示两条投影；重复连接不打开弹窗；第三来源不可添加', () => {
    const initial = candidateWorkflow();
    initial.nodes.push({ ...structuredClone(initial.nodes[1]!), id: 'third' });
    setup(initial);
    expect(projections()).toHaveLength(2);
    expect(projections().every((edge) => edge.reconnectable === false)).toBe(true);
    connect();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(saved).toBe(initial);
    connect('third');
    expect(
      (screen.getByRole('radio', { name: '添加为候选来源' }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.getByText('当前候选输入最多支持两个来源，请先删除一个来源再添加。')).toBeTruthy();
    expect(saved).toBe(initial);
    expect(projections()).toHaveLength(2);
  });
  it('已有单候选可通过原 Handle 补齐第二来源', async () => {
    const initial = candidateWorkflow();
    const binding = initial.nodes[3]!.inputs.prompt!;
    if (binding.type !== 'candidate') throw new Error('fixture');
    binding.sources.pop();
    setup(initial);
    connect();
    fireEvent.click(screen.getByRole('radio', { name: '添加为候选来源' }));
    fireEvent.click(screen.getByRole('button', { name: '确 认' }));
    await waitFor(() => expect(projections()).toHaveLength(2));
    expect(saved.edges).toEqual(initial.edges);
  });
  it.each(['constant', 'template'] as const)(
    '原有 %s 替换确认流程保留，不允许当作整个候选来源',
    async (type) => {
      const initial = ifWorkflow();
      initial.nodes[3]!.inputs.prompt =
        type === 'constant'
          ? { type, value: '内容' }
          : {
              type,
              value: '参考 {{text}}',
              variables: { text: { type: 'node_output', nodeId: 'a', portKey: 'text' } },
            };
      setup(initial);
      connect();
      expect(
        screen.getAllByText('该输入已有内容。连接后将改为使用上游节点输出，当前内容将被替换。'),
      ).toBeTruthy();
      expect(screen.queryByRole('radio')).toBeNull();
      expect(saved).toBe(initial);
      fireEvent.click(screen.getByRole('button', { name: '确认替换' }));
      await waitFor(() => expect(saved.edges).toHaveLength(1));
      expect(saved.nodes[3]!.inputs.prompt).toBeUndefined();
      expect(projections()).toEqual([]);
    },
  );
});
