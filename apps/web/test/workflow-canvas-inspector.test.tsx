// @vitest-environment happy-dom
import { App, Button, ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider, type Edge, type Node, type ReactFlowProps } from '@xyflow/react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StringType,
  type NodeRun,
  type NodeTypeManifest,
  type WorkflowDefinition,
  type WorkflowRunResponse,
} from '@dramaflow/contracts';
import { WorkflowCanvas } from '../src/features/workflow/canvas/workflow-canvas';
import { GenericWorkflowNode } from '../src/features/workflow/canvas/workflow-node';
import type { WorkflowNodeData } from '../src/features/workflow/canvas/react-flow-adapter';
import { nodeTypeKeys } from '../src/features/workflow/node-catalog/node-type-api';
import { useWorkflowDraft } from '../src/features/workflow/editor/use-workflow-draft';
import { useWorkflowRunStatus } from '../src/features/workflow/run/status/use-workflow-run-status';
import {
  CaretFloatingVariablePicker,
  computeCaretFloatingPosition,
} from '../src/features/workflow/inputs/variable-picker';
import type {
  HumanReviewActions,
  WorkflowRunStatusState,
} from '../src/features/workflow/run/status/workflow-run-status';
import { workflowApi } from '../src/features/workflow/workflow-api';
import { ifManifest } from './fixtures/workflow-if';
import { humanReviewManifest, pendingReview, waitingRun } from './fixtures/human-review';

let flow: ReactFlowProps<Node, Edge>;
vi.mock('../src/features/auth/use-identity', () => ({
  useIdentity: () => ({ data: { id: 'user-1' } }),
}));
vi.mock('../src/features/models/model-api', async (original) => {
  const actual = await original<typeof import('../src/features/models/model-api')>();
  return {
    ...actual,
    modelApi: {
      ...actual.modelApi,
      modelCatalog: async () => ({ items: [] }),
      providerCatalog: async () => ({ items: [] }),
      providers: async () => [
        {
          id: '00000000-0000-4000-8000-000000000021',
          ownerId: 'user-1',
          name: 'DeepSeek',
          pluginId: 'openai_compatible',
          pluginVersion: 1,
          providerDefinitionId: null,
          configuration: {},
          enabled: true,
          createdAt: '2026-10-23T00:00:00.000Z',
        },
      ],
      models: async () => [
        {
          id: '00000000-0000-4000-8000-000000000031',
          ownerId: 'user-1',
          providerId: '00000000-0000-4000-8000-000000000021',
          capability: 'text.generate',
          model: 'deepseek-chat',
          settings: {},
          enabled: true,
          createdAt: '2026-10-23T00:00:00.000Z',
          availability: { selectable: true, unavailableReason: null },
        },
      ],
    },
  };
});
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  useReactFlow: () => ({ screenToFlowPosition: (point: unknown) => point }),
  ReactFlow: (props: ReactFlowProps<Node, Edge>) => {
    flow = props;
    return (
      <div data-testid="mock-react-flow">
        {props.nodes
          ?.filter((node) => node.type === 'workflowNode')
          .map((node) => (
            <GenericWorkflowNode
              key={node.id}
              id={node.id}
              type="workflowNode"
              data={node.data as WorkflowNodeData}
              selected={Boolean(node.selected)}
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
      </div>
    );
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const textGenerateManifest: NodeTypeManifest = {
  type: 'ai.text_generate',
  version: 1,
  executionKind: 'action',
  metadata: { name: '文本生成', category: 'ai', description: '使用明确选择的模型配置生成文本' },
  inputs: [
    { key: 'prompt', name: '提示词', dataType: StringType, required: true },
    { key: 'system', name: '系统提示词', dataType: StringType },
  ],
  outputs: [{ key: 'text', name: '生成文本', dataType: StringType }],
  config: [
    {
      key: 'modelConfigurationId',
      name: '模型配置',
      type: 'string',
      required: true,
      ui: { component: 'model-selector' },
    },
  ],
  capabilities: [{ type: 'text.generate' }],
  ui: { inputs: { prompt: { component: 'prompt-editor' }, system: { component: 'textarea' } } },
};

const catalog = [textGenerateManifest, ifManifest, humanReviewManifest];

function createFullWorkflow(): WorkflowDefinition {
  return {
    inputs: [],
    outputs: [
      {
        name: 'final_script',
        type: StringType,
        source: { nodeId: 'node-downstream', outputKey: 'text' },
      },
    ],
    nodes: [
      {
        id: 'node-outline',
        type: 'ai.text_generate',
        typeVersion: 1,
        name: '生成大纲',
        inputs: {
          prompt: { type: 'constant', value: '写一段漫剧大纲' },
        },
        config: {},
        ui: { position: { x: 0, y: 0 } },
      },
      {
        id: 'review-1',
        type: 'flow.human_review',
        typeVersion: 1,
        name: '角色设定审核',
        inputs: {},
        config: { instruction: '请确认角色设定是否符合要求' },
        ui: { position: { x: 280, y: 0 } },
      },
      {
        id: 'node-if',
        type: 'flow.if',
        typeVersion: 1,
        name: '审批分流',
        inputs: {},
        config: {},
        ui: { position: { x: 560, y: 0 } },
      },
      {
        id: 'node-downstream',
        type: 'ai.text_generate',
        typeVersion: 1,
        name: '生成分镜脚本',
        inputs: {},
        config: {},
        ui: { position: { x: 840, y: 0 } },
      },
    ],
    edges: [
      {
        id: 'edge-outline-review',
        kind: 'data',
        source: { nodeId: 'node-outline', portKey: 'text' },
        target: { nodeId: 'review-1', portKey: 'content' },
      },
      {
        id: 'edge-review-if',
        kind: 'data',
        source: { nodeId: 'review-1', portKey: 'action' },
        target: { nodeId: 'node-if', portKey: 'value' },
      },
      {
        id: 'edge-if-true',
        kind: 'control',
        source: { nodeId: 'node-if', portKey: 'true' },
        target: { nodeId: 'node-downstream' },
      },
    ],
  };
}

let currentDraft: ReturnType<typeof useWorkflowDraft>;

function setupCanvas({
  definition = createFullWorkflow(),
  runStatus = null,
  nodeRuns,
  reviewActions,
  locked = false,
}: {
  definition?: WorkflowDefinition;
  runStatus?: WorkflowRunStatusState | null;
  nodeRuns?: readonly NodeRun[];
  reviewActions?: HumanReviewActions;
  locked?: boolean;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(nodeTypeKeys.list, catalog);

  function Harness() {
    currentDraft = useWorkflowDraft({
      id: 'workflow-1',
      projectId: 'project-1',
      name: '工作流',
      revision: 1,
      draft: definition,
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:00:00.000Z',
    });
    return (
      <>
        <Button onClick={currentDraft.save}>保存草稿</Button>
        <Button onClick={currentDraft.reload}>重读草稿</Button>
        <WorkflowCanvas
          projectId="project-1"
          workflow={currentDraft.definition}
          onEdit={currentDraft.edit}
          onOpenProvider={() => {}}
          reloading={false}
          interactionLocked={locked}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          onMoveEnd={() => {}}
          runStatus={runStatus}
          nodeRuns={nodeRuns}
          reviewActions={reviewActions}
        />
      </>
    );
  }

  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <QueryClientProvider client={client}>
          <ReactFlowProvider>
            <Harness />
          </ReactFlowProvider>
        </QueryClientProvider>
      </App>
    </ConfigProvider>,
  );
}

describe('Workflow Canvas Interaction Foundation 核心交互', () => {
  it('默认不展开 Inspector；点击节点打开 Inspector，切换节点同步更新对应配置，Canvas 节点保持轻量', () => {
    setupCanvas();

    // Canvas 节点自身不包含重量级表单控件
    const canvasFlow = screen.getByTestId('mock-react-flow');
    expect(within(canvasFlow).queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('complementary', { name: '节点检查器' })).toBeNull();

    // 1. 点击 Text Generate 节点打开 Inspector
    fireEvent.click(screen.getByRole('article', { name: '生成大纲' }));
    const inspector = screen.getByRole('complementary', { name: '节点检查器' });
    expect(within(inspector).getByRole('textbox', { name: '节点名称' })).toHaveProperty(
      'value',
      '生成大纲',
    );
    expect(within(inspector).getByRole('textbox', { name: '提示词文本' })).toHaveProperty(
      'value',
      '写一段漫剧大纲',
    );

    // 2. 点击 If 节点切换 Inspector 内容
    fireEvent.click(screen.getByRole('article', { name: '审批分流' }));
    expect(within(inspector).getByRole('textbox', { name: '节点名称' })).toHaveProperty(
      'value',
      '审批分流',
    );
    expect(within(inspector).getByRole('combobox', { name: '比较方式' })).toBeTruthy();
    expect(within(inspector).getByText('→ 生成分镜脚本')).toBeTruthy();

    // 3. 点击 Human Review 节点切换 Inspector 内容
    fireEvent.click(screen.getByRole('article', { name: '角色设定审核' }));
    expect(within(inspector).getByRole('textbox', { name: '节点名称' })).toHaveProperty(
      'value',
      '角色设定审核',
    );
    expect(within(inspector).getByRole('textbox', { name: '审核说明' })).toHaveProperty(
      'value',
      '请确认角色设定是否符合要求',
    );

    // 关闭 Inspector
    fireEvent.click(within(inspector).getByRole('button', { name: '关闭节点检查器' }));
    expect(screen.queryByRole('complementary', { name: '节点检查器' })).toBeNull();
  });

  it('Text Generate Inspector 支持 Prompt / System Prompt 的 / Trigger 与显式变量入口、inline Variable Token、Token 删除与 Save/Reload 恢复', async () => {
    setupCanvas();

    fireEvent.click(screen.getByRole('article', { name: '生成分镜脚本' }));
    const inspector = screen.getByRole('complementary', { name: '节点检查器' });

    // 修改节点名称
    fireEvent.change(within(inspector).getByRole('textbox', { name: '节点名称' }), {
      target: { value: '生成正式分镜' },
    });
    expect(currentDraft.definition.nodes.find((n) => n.id === 'node-downstream')?.name).toBe(
      '生成正式分镜',
    );

    // 编辑 System Prompt 普通文本，并通过 / Trigger 插入变量
    const systemEditor = within(inspector).getByRole('textbox', { name: '系统提示词文本' });
    fireEvent.change(systemEditor, {
      target: { value: '你是资深漫剧编剧' },
    });
    expect(
      currentDraft.definition.nodes.find((n) => n.id === 'node-downstream')?.inputs.system,
    ).toEqual({
      type: 'constant',
      value: '你是资深漫剧编剧',
    });

    // 在 System Prompt 中输入 / 触发 Caret Floating Suggestion（不打开按钮 Popover）并插入审核意见变量
    fireEvent.keyDown(systemEditor, { key: '/' });
    expect(screen.getByTestId('caret-variable-suggestion')).toBeTruthy();
    expect(screen.queryByTestId('button-variable-popover')).toBeNull();
    fireEvent.click(await screen.findByRole('option', { name: '角色设定审核 修改意见' }));
    expect(screen.queryByTestId('caret-variable-suggestion')).toBeNull();
    expect(
      currentDraft.definition.nodes.find((n) => n.id === 'node-downstream')?.inputs.system,
    ).toEqual({
      type: 'template',
      value: '你是资深漫剧编剧{{feedback}}',
      variables: {
        feedback: { type: 'node_output', nodeId: 'review-1', portKey: 'feedback' },
      },
    });
    expect(within(inspector).getByText('角色设定审核 · 修改意见')).toBeTruthy();

    // 选择模型配置（Model Configuration）
    fireEvent.click(within(inspector).getByRole('button', { name: '选择模型' }));
    fireEvent.click(await screen.findByRole('option', { name: /deepseek-chat/ }));
    expect(
      currentDraft.definition.nodes.find((n) => n.id === 'node-downstream')?.config
        .modelConfigurationId,
    ).toBe('00000000-0000-4000-8000-000000000031');

    // 通过显式按钮向 Prompt 插入上游变量（打开 Button Popover，不打开 Caret Floating Suggestion）并验证 Template Projection
    fireEvent.click(within(inspector).getByRole('button', { name: '向提示词插入变量' }));
    expect(screen.getByTestId('button-variable-popover')).toBeTruthy();
    expect(screen.queryByTestId('caret-variable-suggestion')).toBeNull();
    fireEvent.click(await screen.findByRole('option', { name: '生成大纲 生成文本' }));

    const downstreamNode = currentDraft.definition.nodes.find((n) => n.id === 'node-downstream')!;
    expect(downstreamNode.inputs.prompt).toEqual({
      type: 'template',
      value: '{{text}}',
      variables: {
        text: { type: 'node_output', nodeId: 'node-outline', portKey: 'text' },
      },
    });
    expect(within(inspector).getByText('生成大纲 · 生成文本')).toBeTruthy();

    const templateProjections = () =>
      flow.edges!.filter((edge) => edge.data?.projection === 'template-input');
    expect(templateProjections()).toHaveLength(2);

    // Save / Reload 后恢复相同的 inline Variable Token
    let savedSnapshot: WorkflowDefinition | undefined;
    vi.spyOn(workflowApi, 'saveDraft').mockImplementation(async (_id, req) => {
      savedSnapshot = structuredClone(req.definition);
      return { revision: 2 };
    });
    vi.spyOn(workflowApi, 'get').mockImplementation(async () => ({
      id: 'workflow-1',
      projectId: 'project-1',
      name: '工作流',
      revision: 2,
      draft: savedSnapshot!,
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:00:00.000Z',
    }));

    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(currentDraft.dirty).toBe(false));

    // 删除 System Prompt 中的变量 Token，验证 unused binding cleanup 与 projection 更新
    fireEvent.click(
      within(inspector).getByRole('button', { name: '删除变量 角色设定审核 修改意见' }),
    );
    expect(
      currentDraft.definition.nodes.find((n) => n.id === 'node-downstream')?.inputs.system,
    ).toEqual({
      type: 'constant',
      value: '你是资深漫剧编剧',
    });
    expect(templateProjections()).toHaveLength(1);

    // 重读草稿后恢复已保存的 Token
    fireEvent.click(screen.getByRole('button', { name: '重读草稿' }));
    await waitFor(() => expect(templateProjections()).toHaveLength(2));
    expect(within(inspector).getByText('角色设定审核 · 修改意见')).toBeTruthy();
  });

  it('Canvas 与 Node Runtime Inspector 基于真实 NodeRun 展示不同节点的 inputs / outputs / error / 多 attempt，不显示整个 Workflow Result', () => {
    const nodeRuns: NodeRun[] = [
      {
        id: 'nr-outline-1',
        workflowRunId: waitingRun.id,
        nodeId: 'node-outline',
        attempt: 1,
        status: 'failed',
        inputs: {
          prompt: { storage: 'inline', type: StringType, value: '第一版提示词' },
        },
        error: {
          stage: 'execute',
          code: 'RATE_LIMITED',
          message: '上游速率限制',
        },
        startedAt: '2026-10-23T00:00:01.000Z',
        completedAt: '2026-10-23T00:00:02.000Z',
      },
      {
        id: 'nr-outline-2',
        workflowRunId: waitingRun.id,
        nodeId: 'node-outline',
        attempt: 2,
        status: 'completed',
        inputs: {
          prompt: { storage: 'inline', type: StringType, value: '写一段漫剧大纲' },
          system: { storage: 'inline', type: StringType, value: '保持悬疑节奏' },
        },
        outputs: {
          text: { storage: 'inline', type: StringType, value: '大纲：雨夜古宅失踪案' },
        },
        startedAt: '2026-10-23T00:00:03.000Z',
        completedAt: '2026-10-23T00:00:05.000Z',
      },
      {
        id: 'nr-downstream-1',
        workflowRunId: waitingRun.id,
        nodeId: 'node-downstream',
        attempt: 1,
        status: 'failed',
        inputs: {
          prompt: { storage: 'inline', type: StringType, value: '基于雨夜古宅展开第一场戏' },
        },
        error: {
          stage: 'execute',
          code: 'EXEC_FAILED',
          message: '分镜生成超时',
        },
        startedAt: '2026-10-23T00:00:06.000Z',
        completedAt: '2026-10-23T00:00:09.000Z',
      },
    ];

    const runStatus: WorkflowRunStatusState = {
      phase: 'ready',
      runId: waitingRun.id,
      run: {
        ...waitingRun,
        status: 'failed',
        outputs: {
          final_script: {
            storage: 'inline',
            type: StringType,
            value: '工作流级最终结果不应出现在节点检查器',
          },
        },
        error: { stage: 'invoke', code: 'EXEC_FAILED', message: '分镜生成超时' },
      },
      nodeRuns,
      error: null,
      refreshing: false,
      review: null,
    };

    setupCanvas({ runStatus });

    // Canvas 基于真实 NodeRun 显示各节点状态：outline 已完成，downstream 执行失败，未执行的节点为尚未执行
    expect(
      within(screen.getByRole('article', { name: '生成大纲' })).getByLabelText(
        '节点状态：执行完成',
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('article', { name: '生成分镜脚本' })).getByLabelText(
        '节点状态：执行失败',
      ),
    ).toBeTruthy();
    const ifArticle = screen.getByRole('article', { name: '审批分流' });
    expect(ifArticle.getAttribute('data-runtime-status')).toBe('idle');
    expect(within(ifArticle).queryByLabelText(/节点状态：/)).toBeNull();

    // 点击“生成大纲”并切换到“运行状态”：默认展示最新 Attempt 2 的真实 inputs / outputs
    fireEvent.click(screen.getByRole('article', { name: '生成大纲' }));
    const inspector = screen.getByRole('complementary', { name: '节点检查器' });
    fireEvent.click(within(inspector).getByRole('tab', { name: '运行状态' }));

    expect(within(inspector).getByText('第 2 次（共 2 次）')).toBeTruthy();
    expect(within(inspector).getByText('2.00 s')).toBeTruthy();
    expect(
      within(within(inspector).getByRole('article', { name: '输入 prompt' })).getByText(
        '写一段漫剧大纲',
      ),
    ).toBeTruthy();
    expect(
      within(within(inspector).getByRole('article', { name: '输入 system' })).getByText(
        '保持悬疑节奏',
      ),
    ).toBeTruthy();
    expect(
      within(within(inspector).getByRole('article', { name: '输出 text' })).getByText(
        '大纲：雨夜古宅失踪案',
      ),
    ).toBeTruthy();

    // 可切换到 Attempt 1 查看历史失败原因与输入
    fireEvent.click(within(inspector).getByRole('button', { name: 'Attempt 1' }));
    expect(within(inspector).getByText('上游速率限制')).toBeTruthy();
    expect(within(inspector).getByText(/RATE_LIMITED/)).toBeTruthy();
    expect(
      within(within(inspector).getByRole('article', { name: '输入 prompt' })).getByText(
        '第一版提示词',
      ),
    ).toBeTruthy();

    // 点击“生成分镜脚本”节点，Inspector 切换为该节点的 NodeRun inputs 与 error
    fireEvent.click(screen.getByRole('article', { name: '生成分镜脚本' }));
    expect(
      within(within(inspector).getByRole('article', { name: '输入 prompt' })).getByText(
        '基于雨夜古宅展开第一场戏',
      ),
    ).toBeTruthy();
    expect(within(inspector).getByText('分镜生成超时')).toBeTruthy();
    expect(within(inspector).getByText(/EXEC_FAILED/)).toBeTruthy();

    // 绝不显示所属 WorkflowRun 或整个 Workflow Result
    expect(within(inspector).queryByText('所属 WorkflowRun')).toBeNull();
    expect(within(inspector).queryByRole('region', { name: '运行结果' })).toBeNull();
    expect(within(inspector).queryByText('工作流级最终结果不应出现在节点检查器')).toBeNull();
  });

  it('Human Review waiting 在 Canvas 展示短摘要与 CTA，点击打开 Runtime Inspector 审批；完成后查看其 NodeRun 自身的 Input / Output', async () => {
    const getRun = vi.spyOn(workflowApi, 'getRun').mockResolvedValue(waitingRun);
    const getPending = vi
      .spyOn(workflowApi, 'getPendingHumanReviews')
      .mockResolvedValue({ items: [pendingReview] });
    const getNodeRuns = vi.spyOn(workflowApi, 'getNodeRuns').mockResolvedValue({
      items: [
        {
          id: 'nr-outline-1',
          workflowRunId: waitingRun.id,
          nodeId: 'node-outline',
          attempt: 1,
          status: 'completed',
          inputs: {
            prompt: { storage: 'inline', type: StringType, value: '写一段漫剧大纲' },
          },
          outputs: {
            text: { storage: 'inline', type: StringType, value: pendingReview.content },
          },
          startedAt: '2026-10-23T00:00:01.000Z',
          completedAt: '2026-10-23T00:00:02.000Z',
        },
        {
          id: 'nr-review-1',
          workflowRunId: waitingRun.id,
          nodeId: 'review-1',
          attempt: 1,
          status: 'running',
          inputs: {
            content: { storage: 'inline', type: StringType, value: pendingReview.content },
          },
          startedAt: '2026-10-23T00:00:03.000Z',
        },
      ],
    });
    const resumeRun = vi.spyOn(workflowApi, 'resumeRun').mockResolvedValue(waitingRun);

    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    client.setQueryData(nodeTypeKeys.list, catalog);

    function LiveRuntimeEditor() {
      currentDraft = useWorkflowDraft({
        id: 'workflow-1',
        projectId: 'project-1',
        name: '工作流',
        revision: 1,
        draft: createFullWorkflow(),
        createdAt: '2026-10-23T00:00:00.000Z',
        updatedAt: '2026-10-23T00:00:00.000Z',
      });
      const status = useWorkflowRunStatus(waitingRun.id);
      return (
        <WorkflowCanvas
          projectId="project-1"
          workflow={currentDraft.definition}
          onEdit={currentDraft.edit}
          onOpenProvider={() => {}}
          reloading={false}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          onMoveEnd={() => {}}
          runStatus={status.state}
          nodeRuns={status.state.nodeRuns}
          reviewActions={status.reviewActions}
          onRefreshRunStatus={() => void status.refresh()}
        />
      );
    }

    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <App>
          <QueryClientProvider client={client}>
            <ReactFlowProvider>
              <LiveRuntimeEditor />
            </ReactFlowProvider>
          </QueryClientProvider>
        </App>
      </ConfigProvider>,
    );

    // 等待 NodeRun 与 pending review 加载完成，Canvas 上的 Human Review 节点直接显示“等待人工审核”及短摘要 CTA
    const reviewNodeArticle = screen.getByRole('article', { name: '角色设定审核' });
    await waitFor(() =>
      expect(within(reviewNodeArticle).getByLabelText('节点状态：等待人工审核')).toBeTruthy(),
    );
    expect(within(reviewNodeArticle).getByText('等待你的审核')).toBeTruthy();
    expect(within(reviewNodeArticle).getByText(/“主角站在窗前。/)).toBeTruthy();
    expect(within(reviewNodeArticle).getByText('查看并审核 →')).toBeTruthy();
    expect(within(reviewNodeArticle).queryByRole('textbox')).toBeNull();
    expect(within(reviewNodeArticle).queryByRole('button', { name: '通过' })).toBeNull();

    // 真实 NodeRun 已完成的“生成大纲”显示执行完成，尚无 NodeRun 的下游节点显示等待执行
    expect(
      within(screen.getByRole('article', { name: '生成大纲' })).getByLabelText(
        '节点状态：执行完成',
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('article', { name: '审批分流' })).getByLabelText(
        '节点状态：等待执行',
      ),
    ).toBeTruthy();

    // 点击 waiting Human Review 节点，直接打开 Runtime Inspector 展示审批 UI
    fireEvent.click(reviewNodeArticle);
    const inspector = screen.getByRole('complementary', { name: '节点检查器' });
    expect(
      within(inspector).getByRole('tab', { name: '运行状态' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(within(inspector).getByRole('region', { name: '人工审核' })).toBeTruthy();
    expect(within(inspector).getByText(pendingReview.instruction!)).toBeTruthy();

    // Runtime Context 中不暴露草稿输入框
    expect(within(inspector).queryByRole('textbox', { name: '节点名称' })).toBeNull();
    expect(within(inspector).queryByRole('textbox', { name: '审核说明' })).toBeNull();

    // 填写 feedback 并先测试 Reject，再测试 Approve
    fireEvent.change(within(inspector).getByRole('textbox', { name: '修改意见 / 反馈' }), {
      target: { value: '请补充反派动机' },
    });

    const secondReview = {
      ...pendingReview,
      interruptId: 'opaque-review-secret-2',
      waitingRevision: 18,
      content: '修订后的角色设定文本',
    };
    getPending.mockResolvedValueOnce({ items: [secondReview] });

    fireEvent.click(within(inspector).getByRole('button', { name: /^拒\s*绝$/ }));
    await waitFor(() =>
      expect(resumeRun).toHaveBeenCalledWith(waitingRun.id, {
        interruptId: pendingReview.interruptId,
        expectedWaitingRevision: 17,
        value: { action: 'reject', feedback: '请补充反派动机' },
      }),
    );

    // 第二轮审批到来后反馈已清空，接着提交通过并完成该 Human Review NodeRun
    await within(inspector).findByText('修订后的角色设定文本');
    expect(
      (within(inspector).getByRole('textbox', { name: '修改意见 / 反馈' }) as HTMLTextAreaElement)
        .value,
    ).toBe('');

    const completedRun: WorkflowRunResponse = {
      ...waitingRun,
      status: 'completed',
      outputs: {
        final_script: { storage: 'inline', type: StringType, value: '工作流级最终剧本成品' },
      },
      completedAt: '2026-10-23T00:05:00.000Z',
    };
    getRun.mockResolvedValueOnce(completedRun);
    getNodeRuns.mockResolvedValueOnce({
      items: [
        {
          id: 'nr-outline-1',
          workflowRunId: waitingRun.id,
          nodeId: 'node-outline',
          attempt: 1,
          status: 'completed',
          inputs: {
            prompt: { storage: 'inline', type: StringType, value: '写一段漫剧大纲' },
          },
          outputs: {
            text: { storage: 'inline', type: StringType, value: '修订后的角色设定文本' },
          },
          startedAt: '2026-10-23T00:00:01.000Z',
          completedAt: '2026-10-23T00:00:02.000Z',
        },
        {
          id: 'nr-review-1',
          workflowRunId: waitingRun.id,
          nodeId: 'review-1',
          attempt: 1,
          status: 'completed',
          inputs: {
            content: { storage: 'inline', type: StringType, value: '修订后的角色设定文本' },
          },
          outputs: {
            content: { storage: 'inline', type: StringType, value: '修订后的角色设定文本' },
            action: { storage: 'inline', type: StringType, value: 'approve' },
            feedback: { storage: 'inline', type: StringType, value: '设定达标，准予通过' },
          },
          startedAt: '2026-10-23T00:00:03.000Z',
          completedAt: '2026-10-23T00:00:08.000Z',
        },
      ],
    });

    fireEvent.click(within(inspector).getByRole('button', { name: /^通\s*过$/ }));
    await waitFor(() =>
      expect(resumeRun).toHaveBeenCalledWith(waitingRun.id, {
        interruptId: secondReview.interruptId,
        expectedWaitingRevision: 18,
        value: { action: 'approve' },
      }),
    );

    // 审批完成后，Human Review NodeRun 变为 completed，Inspector 展示该节点自身的 Input (content) 与 Output (content, action, feedback)
    await within(inspector).findByRole('article', { name: '输出 action' });
    expect(
      within(within(inspector).getByRole('article', { name: '输入 content' })).getByText(
        '修订后的角色设定文本',
      ),
    ).toBeTruthy();
    expect(
      within(within(inspector).getByRole('article', { name: '输出 content' })).getByText(
        '修订后的角色设定文本',
      ),
    ).toBeTruthy();
    expect(
      within(within(inspector).getByRole('article', { name: '输出 action' })).getByText('approve'),
    ).toBeTruthy();
    expect(
      within(within(inspector).getByRole('article', { name: '输出 feedback' })).getByText(
        '设定达标，准予通过',
      ),
    ).toBeTruthy();
    // 不展示整个 WorkflowRunResult
    expect(within(inspector).queryByText('工作流级最终剧本成品')).toBeNull();
    expect(currentDraft.dirty).toBe(false);

    // 切换到“节点配置” Tab 可独立编辑草稿
    fireEvent.click(within(inspector).getByRole('tab', { name: '节点配置' }));
    fireEvent.change(within(inspector).getByRole('textbox', { name: '审核说明' }), {
      target: { value: '新的草稿审核说明' },
    });
    expect(currentDraft.dirty).toBe(true);
    expect(currentDraft.definition.nodes.find((n) => n.id === 'review-1')?.config.instruction).toBe(
      '新的草稿审核说明',
    );

    // 切回“运行状态” Tab，Human Review 的 NodeRun 输出依然保持不变
    fireEvent.click(within(inspector).getByRole('tab', { name: '运行状态' }));
    expect(
      within(within(inspector).getByRole('article', { name: '输出 feedback' })).getByText(
        '设定达标，准予通过',
      ),
    ).toBeTruthy();
  });

  it('CaretFloatingVariablePicker 锚定当前 caret 虚拟引用，支持滚动跟随以及底部 flip / 右侧 shift', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(document.documentElement, 'clientHeight', {
      configurable: true,
      value: 800,
    });

    const scrollContainer = document.createElement('div');
    scrollContainer.style.overflowY = 'auto';
    const editorEl = document.createElement('div');
    scrollContainer.appendChild(editorEl);
    document.body.appendChild(scrollContainer);

    let caretTop = 180;
    const caretLeft = 240;
    const getCaretRect = () => new DOMRect(caretLeft, caretTop, 8, 20);

    const view = render(
      <CaretFloatingVariablePicker
        portName="提示词"
        open={true}
        onClose={() => {}}
        outputs={[
          { nodeId: 'node-outline', nodeName: '生成大纲', portKey: 'text', portName: '生成文本' },
        ]}
        variables={{}}
        slashQuery=""
        slashRange={{ from: 1, to: 2 }}
        getReferenceClientRect={getCaretRect}
        contextElement={editorEl}
        onSelect={() => {}}
      />,
    );

    const floatingEl = screen.getByTestId('caret-variable-suggestion');
    vi.spyOn(floatingEl, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 0, 288, 220),
    );
    Object.defineProperty(floatingEl, 'offsetWidth', { configurable: true, value: 288 });
    Object.defineProperty(floatingEl, 'offsetHeight', { configurable: true, value: 220 });

    // 1. 常规位置：位于光标下方 (bottom-start)，带 6px offset
    await waitFor(() => {
      expect(floatingEl.style.left).toBe('240px');
      expect(floatingEl.style.top).toBe('206px');
      expect(floatingEl.dataset.placement).toBe('bottom-start');
    });

    // 2. Inspector 滚动容器发生滚动，光标上移，Popup 自动跟随
    caretTop = 120;
    fireEvent.scroll(scrollContainer);
    await waitFor(() => {
      expect(floatingEl.style.top).toBe('146px');
      expect(floatingEl.dataset.placement).toBe('bottom-start');
    });

    // 3. 当光标接近视口底部（下方空间不足 220px）且靠近右边缘时，自动 flip 到上方并向左 shift
    const bottomRightPos = await computeCaretFloatingPosition(
      {
        contextElement: editorEl,
        getBoundingClientRect: () => new DOMRect(850, 720, 8, 20),
      },
      floatingEl,
    );
    expect(bottomRightPos.placement).toBe('top-start');
    expect(bottomRightPos.y).toBe(720 - 220 - 6);
    expect(bottomRightPos.x).toBe(1000 - 288 - 8);

    view.unmount();
    scrollContainer.remove();
  });
});
