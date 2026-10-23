// @vitest-environment happy-dom
import { useState } from 'react';
import { App, ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Node, Edge, ReactFlowProps } from '@xyflow/react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowCanvas } from '../src/features/workflow/canvas/workflow-canvas';
import { nodeTypeKeys } from '../src/features/workflow/node-catalog/node-type-api';
import { END_INPUT_HANDLE } from '../src/features/workflow/outputs/workflow-outputs';
import { definition, manifest } from './fixtures/workflow-output';
import type { WorkflowDefinition } from '@dramaflow/contracts';

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
function setup(initial = definition(), locked = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(nodeTypeKeys.list, [manifest]);
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
        interactionLocked={locked}
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
function endNode() {
  return flow.nodes!.find((node) => node.type === 'workflowEnd')!;
}
function connectEnd() {
  act(() =>
    flow.onConnect!({
      source: 'b',
      sourceHandle: 'text',
      target: endNode().id,
      targetHandle: END_INPUT_HANDLE,
    }),
  );
}

describe('Canvas 的 End Boundary 路由', () => {
  it('第二次拖线可取消或明确加入 result，删除线仅移除其候选', () => {
    setup();
    connectEnd();
    act(() =>
      flow.onConnect!({
        source: 'a',
        sourceHandle: 'text',
        target: endNode().id,
        targetHandle: END_INPUT_HANDLE,
      }),
    );
    expect(saved.outputs[0]!.source).toEqual({ nodeId: 'b', outputKey: 'text' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(saved.outputs).toHaveLength(1);
    act(() =>
      flow.onConnect!({
        source: 'a',
        sourceHandle: 'text',
        target: endNode().id,
        targetHandle: END_INPUT_HANDLE,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '加入 result 的候选' }));
    expect(saved.outputs[0]!.sources).toEqual([
      { nodeId: 'b', outputKey: 'text' },
      { nodeId: 'a', outputKey: 'text' },
    ]);
    expect(flow.edges).toHaveLength(2);
    expect(saved.edges).toEqual([]);
    act(() => flow.onEdgesDelete!([flow.edges!.find((edge) => edge.source === 'b')!]));
    expect(saved.outputs[0]!.sources).toEqual([{ nodeId: 'a', outputKey: 'text' }]);
    act(() => flow.onNodesChange!([{ type: 'remove', id: 'a' }]));
    expect(saved.outputs[0]!.sources).toEqual([]);
    expect(flow.edges).toEqual([]);
  });
  it('始终显示 End，移动仅改变视图；业务输出拖到 End 只修改 outputs', async () => {
    setup();
    await waitFor(() => expect(flow.nodesConnectable).toBe(true));
    const original = saved;
    act(() =>
      flow.onNodesChange!([{ type: 'position', id: endNode().id, position: { x: 800, y: 200 } }]),
    );
    expect(endNode().position).toEqual({ x: 800, y: 200 });
    expect(saved).toBe(original);
    connectEnd();
    expect(saved.outputs).toEqual([
      {
        name: 'result',
        source: { nodeId: 'b', outputKey: 'text' },
        type: manifest.outputs[0]!.dataType,
      },
    ]);
    expect(saved.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    expect(saved.edges).toEqual([]);
    expect(flow.edges).toHaveLength(1);
    connectEnd();
    fireEvent.click(screen.getByRole('button', { name: '新建独立输出' }));
    expect(saved.outputs.map((output) => output.name)).toEqual(['result', 'result_2']);
    act(() => flow.onEdgesDelete!([flow.edges![0]!]));
    expect(saved.outputs.map((output) => output.name)).toEqual(['result_2']);
    expect(saved.edges).toEqual([]);
  });
  it('业务节点删除清除输出和视图连线；End 不可删除', () => {
    setup();
    connectEnd();
    expect(endNode().deletable).toBe(false);
    act(() => flow.onNodesChange!([{ type: 'remove', id: 'b' }]));
    expect(saved.nodes.map((node) => node.id)).toEqual(['a']);
    expect(saved.outputs).toEqual([]);
    expect(flow.edges).toEqual([]);
  });
  it('普通数据与控制连线仍写 edges，End 拒绝控制端口', () => {
    setup();
    expect(
      flow.isValidConnection!({
        source: 'b',
        sourceHandle: 'control:source',
        target: endNode().id,
        targetHandle: END_INPUT_HANDLE,
      }),
    ).toBe(false);
    act(() =>
      flow.onConnect!({ source: 'a', sourceHandle: 'text', target: 'b', targetHandle: 'prompt' }),
    );
    act(() =>
      flow.onConnect!({
        source: 'a',
        sourceHandle: 'control:source',
        target: 'b',
        targetHandle: 'control:target',
      }),
    );
    expect(saved.edges.map((edge) => edge.kind)).toEqual(['data', 'control']);
    expect(saved.outputs).toEqual([]);
  });
  it('锁定期间不允许通过 End 改动草稿', () => {
    setup(definition(), true);
    connectEnd();
    expect(saved.outputs).toEqual([]);
  });
});
