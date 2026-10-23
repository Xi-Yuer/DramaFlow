// @vitest-environment happy-dom
import { App, Button, ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider, type Node, type Edge, type ReactFlowProps } from '@xyflow/react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowResponse } from '@dramaflow/contracts';
import { WorkflowCanvas } from '../src/features/workflow/canvas/workflow-canvas';
import { GenericWorkflowNode } from '../src/features/workflow/canvas/workflow-node';
import type { WorkflowNodeData } from '../src/features/workflow/canvas/react-flow-adapter';
import { nodeTypeKeys } from '../src/features/workflow/node-catalog/node-type-api';
import { useWorkflowDraft } from '../src/features/workflow/editor/use-workflow-draft';
import { workflowApi } from '../src/features/workflow/workflow-api';
import { ifCatalog, ifWorkflow } from './fixtures/workflow-if';
import { humanReviewManifest } from './fixtures/human-review';
import { createWorkflowNode } from '../src/features/workflow/node-catalog/create-workflow-node';

let flow: ReactFlowProps<Node, Edge>;
let draft: ReturnType<typeof useWorkflowDraft>;
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  useReactFlow: () => ({ screenToFlowPosition: (point: unknown) => point }),
  ReactFlow: (props: ReactFlowProps<Node, Edge>) => {
    flow = props;
    return (
      <>
        {props.nodes
          ?.filter((node) => node.type === 'workflowNode')
          .map((node) => (
            <GenericWorkflowNode
              key={node.id}
              id={node.id}
              type="workflowNode"
              data={node.data as WorkflowNodeData}
              selected={false}
              dragging={false}
              zIndex={0}
              selectable
              deletable
              draggable
              isConnectable
              positionAbsoluteX={node.position.x}
              positionAbsoluteY={node.position.y}
            />
          ))}
      </>
    );
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const workflow: WorkflowResponse = {
  id: 'workflow',
  projectId: '7ac10b00-33cc-4e50-9a2b-05ef764c44f4',
  name: '工作流',
  revision: 1,
  draft: ifWorkflow(),
  createdAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:00.000Z',
};
function setup(definition = ifWorkflow(), locked = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(nodeTypeKeys.list, [...ifCatalog, humanReviewManifest]);
  function Editor() {
    draft = useWorkflowDraft({ ...workflow, draft: definition });
    return (
      <>
        <Button onClick={draft.save}>保存草稿</Button>
        <Button onClick={draft.reload}>重读草稿</Button>
        <WorkflowCanvas
          projectId={workflow.projectId}
          workflow={draft.definition}
          onEdit={draft.edit}
          onOpenProvider={() => {}}
          reloading={false}
          interactionLocked={locked}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          onMoveEnd={() => {}}
        />
      </>
    );
  }
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <QueryClientProvider client={client}>
          <ReactFlowProvider>
            <Editor />
          </ReactFlowProvider>
        </QueryClientProvider>
      </App>
    </ConfigProvider>,
  );
}

describe('Human Review 复用通用节点编辑', () => {
  it('从正式目录创建 interaction，编辑节点名称、静态 instruction 和文本 content', async () => {
    const view = setup({ ...ifWorkflow(), nodes: [] });
    fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
    fireEvent.click(await screen.findByRole('button', { name: '添加 人工审批 · v1' }));
    expect(draft.definition.nodes).toHaveLength(1);
    expect(draft.definition.nodes[0]).toMatchObject({
      type: 'flow.human_review',
      typeVersion: 1,
      inputs: {},
      config: {},
    });
    fireEvent.change(screen.getByRole('textbox', { name: '节点名称' }), {
      target: { value: '角色审核' },
    });
    fireEvent.blur(screen.getByRole('textbox', { name: '节点名称' }));
    fireEvent.change(screen.getByRole('textbox', { name: '审核说明' }), {
      target: { value: '核对 {{literal}} 内容' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '待审核内容文本' }), {
      target: { value: '原始内容' },
    });
    expect(draft.definition.nodes[0]).toMatchObject({
      name: '角色审核',
      config: { instruction: '核对 {{literal}} 内容' },
      inputs: { content: { type: 'constant', value: '原始内容' } },
    });
    expect(view.container.querySelector('[data-handleid="content"].target')).toBeTruthy();
    for (const port of ['content', 'action', 'feedback'])
      expect(view.container.querySelector(`[data-handleid="${port}"].source`)).toBeTruthy();
    expect(view.container.querySelector('[data-handleid="control:source:approve"]')).toBeNull();
    expect(view.container.querySelector('[data-handleid="control:source:reject"]')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '审核说明' }), { target: { value: '' } });
    expect(draft.definition.nodes[0]!.config).not.toHaveProperty('instruction');
  });

  it('普通 DataEdge 输入及三个输出可连接，保存/reload 不增加审批专属状态', async () => {
    const definition = ifWorkflow();
    definition.nodes.push(
      createWorkflowNode(humanReviewManifest, 'review', '人工审批', { x: 400, y: 0 }),
    );
    setup(definition);
    act(() =>
      flow.onConnect?.({
        source: 'a',
        sourceHandle: 'text',
        target: 'review',
        targetHandle: 'content',
      }),
    );
    for (const [index, port] of ['content', 'action', 'feedback'].entries()) {
      act(() =>
        flow.onConnect?.({
          source: 'review',
          sourceHandle: port,
          target: ['b', 'if', 'c'][index]!,
          targetHandle: index === 1 ? 'value' : 'prompt',
        }),
      );
    }
    expect(draft.definition.edges.filter((edge) => edge.kind === 'data')).toHaveLength(4);
    fireEvent.click(screen.getByRole('article', { name: '人工审批' }));
    expect(
      within(screen.getByRole('complementary', { name: '节点检查器' })).getByText(
        '该输入由连线提供',
      ),
    ).toBeTruthy();
    const saved = structuredClone(draft.definition);
    vi.spyOn(workflowApi, 'saveDraft').mockResolvedValue({ revision: 2 });
    vi.spyOn(workflowApi, 'get').mockResolvedValue({ ...workflow, revision: 2, draft: saved });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(draft.dirty).toBe(false));
    expect(workflowApi.saveDraft).toHaveBeenCalledWith(workflow.id, {
      expectedRevision: 1,
      definition: saved,
    });
    fireEvent.click(screen.getByRole('button', { name: '重读草稿' }));
    await waitFor(() => expect(workflowApi.get).toHaveBeenCalled());
    expect(draft.definition).toEqual(saved);
  });

  it('锁定期间不允许改名称、instruction 或 content', () => {
    const definition = {
      ...ifWorkflow(),
      nodes: [createWorkflowNode(humanReviewManifest, 'review', '人工审批', { x: 0, y: 0 })],
    };
    setup(definition, true);
    fireEvent.click(screen.getByRole('article', { name: '人工审批' }));
    for (const name of ['节点名称', '审核说明', '待审核内容文本'])
      expect((screen.getByRole('textbox', { name }) as HTMLInputElement).disabled).toBe(true);
  });
});
