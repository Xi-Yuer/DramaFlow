import { describe, expect, it } from 'vitest';
import {
  StringType,
  type NodeRun,
  type WorkflowDefinition,
  type WorkflowRunResponse,
} from '@dramaflow/contracts';
import { getRuntimeNodePresentation } from '../src/features/workflow/runtime/runtime-presentation';
import {
  formatNodeRunDuration,
  resolveWorkflowRuntimeNodes,
  type RuntimeNodeStatus,
} from '../src/features/workflow/runtime/runtime-status';
import type { WorkflowRunStatusState } from '../src/features/workflow/run/status/workflow-run-status';
import { pendingReview, waitingRun } from './fixtures/human-review';

function createWorkflow(): WorkflowDefinition {
  return {
    inputs: [],
    outputs: [],
    nodes: [
      {
        id: 'node-generate',
        type: 'ai.text_generate',
        typeVersion: 1,
        name: '生成角色描述',
        inputs: {},
        config: {},
        ui: { position: { x: 0, y: 0 } },
      },
      {
        id: 'review-1',
        type: 'flow.human_review',
        typeVersion: 1,
        name: '角色设定审核',
        inputs: {},
        config: {},
        ui: { position: { x: 260, y: 0 } },
      },
      {
        id: 'node-if',
        typeVersion: 1,
        type: 'flow.if',
        name: '条件分支',
        inputs: {},
        config: {},
        ui: { position: { x: 520, y: 0 } },
      },
    ],
    edges: [
      {
        id: 'edge-1',
        kind: 'data',
        source: { nodeId: 'node-generate', portKey: 'text' },
        target: { nodeId: 'review-1', portKey: 'content' },
      },
      {
        id: 'edge-2',
        kind: 'data',
        source: { nodeId: 'review-1', portKey: 'action' },
        target: { nodeId: 'node-if', portKey: 'value' },
      },
    ],
  };
}

function makeRunStatus(
  run: WorkflowRunResponse | null,
  review = null as WorkflowRunStatusState['review'],
  nodeRuns: readonly NodeRun[] = [],
): WorkflowRunStatusState {
  return {
    phase: run ? 'ready' : 'idle',
    runId: run?.id ?? null,
    run,
    nodeRuns,
    error: null,
    refreshing: false,
    review,
  };
}

describe('集中式 Runtime Node Status（真实 NodeRun execution facts 优先）', () => {
  it('无运行或终态运行下没有 NodeRun 的节点均为 idle，进行中运行下没有 NodeRun 的节点为 pending，不按拓扑猜测完成状态', () => {
    const workflow = createWorkflow();

    const idleMap = resolveWorkflowRuntimeNodes({ workflow, runStatus: null });
    for (const node of workflow.nodes) {
      expect(idleMap.get(node.id)?.status).toBe('idle');
      expect(idleMap.get(node.id)?.nodeRun).toBeNull();
    }

    const runningWithoutNodeRuns = resolveWorkflowRuntimeNodes({
      workflow,
      runStatus: makeRunStatus({ ...waitingRun, status: 'running' }),
    });
    for (const node of workflow.nodes) {
      expect(runningWithoutNodeRuns.get(node.id)?.status).toBe('pending');
    }

    const completedWithoutNodeRuns = resolveWorkflowRuntimeNodes({
      workflow,
      runStatus: makeRunStatus({ ...waitingRun, status: 'completed' }),
    });
    for (const node of workflow.nodes) {
      expect(completedWithoutNodeRuns.get(node.id)?.status).toBe('idle');
    }
  });

  it('根据真实 NodeRun 精确映射 Action running / completed / failed，并保留完整 attempts 历史与最新 attempt', () => {
    const workflow = createWorkflow();
    const nodeRuns: NodeRun[] = [
      {
        id: 'nr-gen-1',
        workflowRunId: waitingRun.id,
        nodeId: 'node-generate',
        attempt: 1,
        status: 'failed',
        inputs: {
          prompt: { storage: 'inline', type: StringType, value: '生成角色' },
        },
        error: { stage: 'execute', code: 'TIMEOUT', message: '首次调用超时' },
        startedAt: '2026-10-23T00:00:01.000Z',
        completedAt: '2026-10-23T00:00:02.000Z',
      },
      {
        id: 'nr-gen-2',
        workflowRunId: waitingRun.id,
        nodeId: 'node-generate',
        attempt: 2,
        status: 'completed',
        inputs: {
          prompt: { storage: 'inline', type: StringType, value: '生成角色' },
        },
        outputs: {
          text: { storage: 'inline', type: StringType, value: '主角设定文本' },
        },
        startedAt: '2026-10-23T00:00:03.000Z',
        completedAt: '2026-10-23T00:00:04.500Z',
      },
      {
        id: 'nr-review-1',
        workflowRunId: waitingRun.id,
        nodeId: 'review-1',
        attempt: 1,
        status: 'running',
        inputs: {
          content: { storage: 'inline', type: StringType, value: '主角设定文本' },
        },
        startedAt: '2026-10-23T00:00:05.000Z',
      },
    ];

    const map = resolveWorkflowRuntimeNodes({
      workflow,
      runStatus: makeRunStatus({ ...waitingRun, status: 'running' }, null, nodeRuns),
    });

    const genState = map.get('node-generate')!;
    expect(genState.status).toBe('completed');
    expect(genState.nodeRun?.id).toBe('nr-gen-2');
    expect(genState.nodeRun?.attempt).toBe(2);
    expect(genState.attempts.map((item) => item.attempt)).toEqual([1, 2]);
    expect(genState.error).toBeNull();
    expect(formatNodeRunDuration(genState.nodeRun!.startedAt, genState.nodeRun!.completedAt)).toBe(
      '1.50 s',
    );

    const reviewState = map.get('review-1')!;
    expect(reviewState.status).toBe('running');
    expect(reviewState.isWaitingHumanReview).toBe(false);

    const ifState = map.get('node-if')!;
    expect(ifState.status).toBe('pending');
    expect(ifState.nodeRun).toBeNull();
  });

  it('Human Review waiting 由 NodeRun(running) + PendingHumanReview 合成为 waiting；Resume 完成后由 NodeRun(completed) 映射为 completed', () => {
    const workflow = createWorkflow();
    const waitingNodeRuns: NodeRun[] = [
      {
        id: 'nr-gen-1',
        workflowRunId: waitingRun.id,
        nodeId: 'node-generate',
        attempt: 1,
        status: 'completed',
        inputs: {
          prompt: { storage: 'inline', type: StringType, value: '生成角色' },
        },
        outputs: {
          text: { storage: 'inline', type: StringType, value: '主角站在窗前。' },
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
    ];

    const waitingMap = resolveWorkflowRuntimeNodes({
      workflow,
      runStatus: makeRunStatus(
        waitingRun,
        {
          phase: 'ready',
          item: pendingReview,
          feedback: '',
          notice: null,
        },
        waitingNodeRuns,
      ),
    });

    expect(waitingMap.get('node-generate')?.status).toBe('completed');
    expect(waitingMap.get('review-1')?.status).toBe('waiting');
    expect(waitingMap.get('review-1')?.isWaitingHumanReview).toBe(true);
    expect(waitingMap.get('review-1')?.nodeRun?.status).toBe('running');
    expect(waitingMap.get('node-if')?.status).toBe('pending');

    // Resume 后 NodeRun 变为 completed
    const completedNodeRuns: NodeRun[] = [
      waitingNodeRuns[0]!,
      {
        ...waitingNodeRuns[1]!,
        status: 'completed',
        outputs: {
          content: { storage: 'inline', type: StringType, value: pendingReview.content },
          action: { storage: 'inline', type: StringType, value: 'approve' },
          feedback: { storage: 'inline', type: StringType, value: '通过审核' },
        },
        completedAt: '2026-10-23T00:00:10.000Z',
      },
    ];

    const completedMap = resolveWorkflowRuntimeNodes({
      workflow,
      runStatus: makeRunStatus({ ...waitingRun, status: 'completed' }, null, completedNodeRuns),
    });

    expect(completedMap.get('review-1')?.status).toBe('completed');
    expect(completedMap.get('review-1')?.isWaitingHumanReview).toBe(false);
    expect(completedMap.get('review-1')?.nodeRun?.outputs?.action).toEqual({
      storage: 'inline',
      type: StringType,
      value: 'approve',
    });
    expect(completedMap.get('node-if')?.status).toBe('idle');
  });

  it('Presentation Mapping 统一映射状态语义与视觉语义，Human Review waiting 显示等待人工审核', () => {
    const expectedLabels: Record<RuntimeNodeStatus, string> = {
      idle: '尚未执行',
      pending: '等待执行',
      running: '正在执行',
      waiting: '等待人工操作',
      completed: '执行完成',
      failed: '执行失败',
    };
    for (const [status, label] of Object.entries(expectedLabels) as [RuntimeNodeStatus, string][]) {
      const presentation = getRuntimeNodePresentation(status);
      expect(presentation.label).toBe(label);
      expect(presentation.canvasLabel).toBe(label);
      expect(presentation.tone).toBe(status);
    }
    const humanReviewWaiting = getRuntimeNodePresentation('waiting', { isHumanReview: true });
    expect(humanReviewWaiting.label).toBe('等待人工审核');
    expect(humanReviewWaiting.canvasLabel).toBe('等待人工审核');
    expect(humanReviewWaiting.tagColor).toBe('warning');
  });
});
