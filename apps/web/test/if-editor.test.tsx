// @vitest-environment happy-dom
import { App, Button, ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider, type Node, type Edge, type ReactFlowProps } from '@xyflow/react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition, WorkflowResponse } from '@dramaflow/contracts';
import { WorkflowCanvas } from '../src/features/workflow/canvas/workflow-canvas';
import { GenericWorkflowNode } from '../src/features/workflow/canvas/workflow-node';
import type { WorkflowNodeData } from '../src/features/workflow/canvas/react-flow-adapter';
import { nodeTypeKeys } from '../src/features/workflow/node-catalog/node-type-api';
import { useWorkflowDraft } from '../src/features/workflow/editor/use-workflow-draft';
import { workflowApi } from '../src/features/workflow/workflow-api';
import { conditionFromFields } from '../src/features/workflow/conditions/if-condition';
import { ifCatalog, ifWorkflow } from './fixtures/workflow-if';

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
  client.setQueryData(nodeTypeKeys.list, ifCatalog);
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
async function choose(label: string) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '比较方式' }));
  fireEvent.click(await screen.findByText(label, { selector: '.ant-select-item-option-content' }));
}

describe('If Generic Node 编辑', () => {
  it('目录创建精确 If；不默认填条件/输入，Handle 由 Manifest 生成', async () => {
    const view = setup({ ...ifWorkflow(), nodes: [] });
    fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
    fireEvent.click(await screen.findByRole('button', { name: '添加 条件分支 · v1' }));
    expect(draft.definition.nodes).toHaveLength(1);
    expect(draft.definition.nodes[0]).toMatchObject({
      type: 'flow.if',
      typeVersion: 1,
      config: {},
      inputs: {},
    });
    expect(screen.getByText('尚未配置条件')).toBeTruthy();
    expect(view.container.querySelector('[data-handleid="value"]')).toBeTruthy();
    expect(view.container.querySelector('[data-handleid="control:source:true"]')).toBeTruthy();
    expect(view.container.querySelector('[data-handleid="control:source:false"]')).toBeTruthy();
    expect(view.container.querySelector('[data-handleid="control:source"]')).toBeNull();
  });
  it.each([
    ['等于', 'equals'],
    ['不等于', 'not_equals'],
    ['包含', 'contains'],
    ['不包含', 'not_contains'],
  ] as const)('%s 使用表单生成协议，保存后重读恢复同一表单', async (label, operator) => {
    setup();
    await choose(label);
    fireEvent.change(screen.getByRole('textbox', { name: '比较文本' }), {
      target: { value: ' 通过\nApproved ' },
    });
    const expression = conditionFromFields(operator, ' 通过\nApproved ');
    expect(draft.definition.nodes[0]!.config).toEqual({ condition: expression });
    expect(screen.getByText(`value ${label} " 通过\\nApproved "`)).toBeTruthy();
    let stored: WorkflowDefinition | undefined;
    const save = vi.spyOn(workflowApi, 'saveDraft').mockImplementation(async (_id, request) => {
      stored = structuredClone(request.definition);
      return { revision: 2 };
    });
    vi.spyOn(workflowApi, 'get').mockImplementation(async () => ({
      ...workflow,
      revision: 2,
      draft: stored!,
    }));
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(draft.dirty).toBe(false));
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '清除条件' }));
    expect(draft.definition.nodes[0]!.config).toEqual({});
    fireEvent.click(screen.getByRole('button', { name: '重读草稿' }));
    await waitFor(() => expect(draft.definition.nodes[0]!.config.condition).toEqual(expression));
    expect((screen.getByRole('textbox', { name: '比较文本' }) as HTMLTextAreaElement).value).toBe(
      ' 通过\nApproved ',
    );
  });
  it('不支持的 expression 保留，其他编辑和保存均不覆盖；明确替换后才改写', async () => {
    const initial = ifWorkflow();
    const expression = { and: [{ '===': [{ var: 'value' }, 'x'] }] };
    initial.nodes[0]!.config.condition = expression;
    setup(initial);
    expect(screen.getByText('当前编辑器暂不支持该条件表达式')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: '比较方式' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '输入值文本' }), {
      target: { value: '业务文本' },
    });
    const save = vi.spyOn(workflowApi, 'saveDraft').mockResolvedValue({ revision: 2 });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(draft.dirty).toBe(false));
    expect(save.mock.calls[0]![1].definition.nodes[0]!.config.condition).toEqual(expression);
    fireEvent.click(screen.getByRole('button', { name: '替换为可编辑条件' }));
    expect(draft.definition.nodes[0]!.config.condition).toEqual(conditionFromFields('equals', ''));
    expect(draft.definition.nodes[0]!.inputs.value).toEqual({
      type: 'constant',
      value: '业务文本',
    });
  });
  it('不完整 If 可 Save；DataEdge / 命名控制边走现有 Canvas 持久化与删除回调', async () => {
    setup({ ...ifWorkflow(), nodes: ifWorkflow().nodes.filter((node) => node.id !== 'if') });
    fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
    fireEvent.click(await screen.findByRole('button', { name: '添加 条件分支 · v1' }));
    const id = draft.definition.nodes.find((node) => node.type === 'flow.if')!.id;
    const save = vi.spyOn(workflowApi, 'saveDraft').mockResolvedValue({ revision: 2 });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(draft.dirty).toBe(false));
    expect(save.mock.calls[0]![1].definition.nodes.find((node) => node.id === id)!.config).toEqual(
      {},
    );
    act(() =>
      flow.onConnect!({ source: 'a', sourceHandle: 'text', target: id, targetHandle: 'value' }),
    );
    act(() =>
      flow.onConnect!({
        source: id,
        sourceHandle: 'control:source:true',
        target: 'b',
        targetHandle: 'control:target',
      }),
    );
    act(() =>
      flow.onConnect!({
        source: id,
        sourceHandle: 'control:source:false',
        target: 'c',
        targetHandle: 'control:target',
      }),
    );
    expect(draft.definition.edges.map((edge) => edge.source.portKey)).toEqual([
      'text',
      'true',
      'false',
    ]);
    expect(screen.getByText('该输入由连线提供')).toBeTruthy();
    const before = draft.definition;
    act(() =>
      flow.onConnect!({
        source: id,
        sourceHandle: 'control:source:false',
        target: 'b',
        targetHandle: 'control:target',
      }),
    );
    expect(draft.definition).toEqual(before);
    expect(draft.error).toContain('已连接');
    act(() =>
      flow.onEdgesDelete!([
        flow.edges!.find((edge) => edge.sourceHandle === 'control:source:true')!,
      ]),
    );
    expect(draft.definition.edges.map((edge) => edge.source.portKey)).toEqual(['text', 'false']);
  });
  it('发布/重载锁定时不能编辑条件', async () => {
    const initial = ifWorkflow();
    initial.nodes[0]!.config.condition = conditionFromFields('equals', 'x');
    setup(initial, true);
    expect(
      (screen.getByRole('textbox', { name: '比较文本' }) as HTMLTextAreaElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '清除条件' }));
    expect(draft.definition).toEqual(initial);
  });
});
