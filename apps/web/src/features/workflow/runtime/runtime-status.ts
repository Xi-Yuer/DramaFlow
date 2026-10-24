'use client';

import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react';
import type {
  NodeRun,
  NodeRunError,
  WorkflowDefinition,
  WorkflowRunResponse,
} from '@dramaflow/contracts';
import { ROOT_EXECUTION_SCOPE_KEY } from '@dramaflow/contracts';
import type {
  HumanReviewActions,
  HumanReviewState,
  WorkflowRunStatusError,
  WorkflowRunStatusState,
} from '../run/status/workflow-run-status';

export type RuntimeNodeStatus = 'idle' | 'pending' | 'running' | 'waiting' | 'completed' | 'failed';

export interface WorkflowNodeRuntimeState {
  nodeId: string;
  status: RuntimeNodeStatus;
  isWaitingHumanReview: boolean;
  review: HumanReviewState | null;
  error: NodeRunError | null;
  nodeRun: NodeRun | null;
  attempts: readonly NodeRun[];
  run: WorkflowRunResponse | null;
  runRefreshing: boolean;
  runError: WorkflowRunStatusError | null;
}

export interface WorkflowRuntimeInput {
  workflow: Pick<WorkflowDefinition, 'nodes' | 'edges'>;
  runStatus?: WorkflowRunStatusState | null;
  nodeRuns?: readonly NodeRun[];
}

export function defaultWorkflowNodeRuntimeState(nodeId: string): WorkflowNodeRuntimeState {
  return {
    nodeId,
    status: 'idle',
    isWaitingHumanReview: false,
    review: null,
    error: null,
    nodeRun: null,
    attempts: [],
    run: null,
    runRefreshing: false,
    runError: null,
  };
}

export function formatNodeRunDuration(startedAt: string, completedAt?: string): string | null {
  if (!completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function groupNodeRunsByNodeId(
  nodeRuns: readonly NodeRun[] | undefined,
): Map<string, readonly NodeRun[]> {
  const grouped = new Map<string, NodeRun[]>();
  if (!nodeRuns) return grouped;
  for (const record of nodeRuns) {
    // 当前 Inspector 只展示 root scope，不能让子 scope 的高 attempt 覆盖 root。
    if (record.scopeKey !== ROOT_EXECUTION_SCOPE_KEY) continue;
    const list = grouped.get(record.nodeId) ?? [];
    if (list[0] && list[0].occurrenceId !== record.occurrenceId)
      throw new Error('同一 root 节点存在不一致的 occurrence 身份');
    list.push(record);
    grouped.set(record.nodeId, list);
  }
  for (const [nodeId, list] of grouped.entries()) {
    list.sort((a, b) => a.attempt - b.attempt);
    grouped.set(nodeId, list);
  }
  return grouped;
}

// 真实 NodeRun execution facts + PendingHumanReview 优先；不依赖 Workflow topology 猜测节点执行结果。
export function resolveWorkflowRuntimeNodes({
  workflow,
  runStatus,
  nodeRuns,
}: WorkflowRuntimeInput): ReadonlyMap<string, WorkflowNodeRuntimeState> {
  const run = runStatus?.run ?? null;
  const review = runStatus?.review ?? null;
  const runRefreshing = runStatus?.refreshing ?? false;
  const runError = runStatus?.error ?? null;
  const effectiveNodeRuns = nodeRuns ?? runStatus?.nodeRuns;
  const groupedNodeRuns = groupNodeRunsByNodeId(effectiveNodeRuns);
  const activeRunInProgress =
    run !== null &&
    (run.status === 'pending' || run.status === 'running' || run.status === 'waiting');

  const result = new Map<string, WorkflowNodeRuntimeState>();

  for (const node of workflow.nodes) {
    const attempts = groupedNodeRuns.get(node.id) ?? [];
    const latestNodeRun = attempts.at(-1) ?? null;

    // Human Review 等待期间 NodeRun.status = running，结合指向该 nodeId 的 PendingHumanReview 合成 waiting 状态。
    const isWaitingHumanReview =
      run?.status === 'waiting' &&
      review?.item.node.id === node.id &&
      (latestNodeRun === null || latestNodeRun.status === 'running');

    if (isWaitingHumanReview) {
      result.set(node.id, {
        nodeId: node.id,
        status: 'waiting',
        isWaitingHumanReview: true,
        review,
        error: null,
        nodeRun: latestNodeRun,
        attempts,
        run,
        runRefreshing,
        runError,
      });
      continue;
    }

    if (latestNodeRun) {
      result.set(node.id, {
        nodeId: node.id,
        status: latestNodeRun.status,
        isWaitingHumanReview: false,
        review: null,
        error: latestNodeRun.error ?? null,
        nodeRun: latestNodeRun,
        attempts,
        run,
        runRefreshing,
        runError,
      });
      continue;
    }

    result.set(node.id, {
      nodeId: node.id,
      status: activeRunInProgress ? 'pending' : 'idle',
      isWaitingHumanReview: false,
      review: null,
      error: null,
      nodeRun: null,
      attempts: [],
      run,
      runRefreshing,
      runError,
    });
  }

  return result;
}

export interface WorkflowRuntimeContextValue {
  nodes: ReadonlyMap<string, WorkflowNodeRuntimeState>;
  runStatus: WorkflowRunStatusState | null;
  reviewActions?: HumanReviewActions;
  onRefreshRunStatus?: () => void;
}

const WorkflowRuntimeContext = createContext<WorkflowRuntimeContextValue>({
  nodes: new Map(),
  runStatus: null,
});

export function WorkflowRuntimeProvider({
  workflow,
  runStatus = null,
  nodeRuns,
  reviewActions,
  onRefreshRunStatus,
  children,
}: {
  workflow: Pick<WorkflowDefinition, 'nodes' | 'edges'>;
  runStatus?: WorkflowRunStatusState | null;
  nodeRuns?: readonly NodeRun[];
  reviewActions?: HumanReviewActions;
  onRefreshRunStatus?: () => void;
  children: ReactNode;
}) {
  const nodes = useMemo(
    () => resolveWorkflowRuntimeNodes({ workflow, runStatus, nodeRuns }),
    [workflow, runStatus, nodeRuns],
  );
  const value = useMemo<WorkflowRuntimeContextValue>(
    () => ({
      nodes,
      runStatus,
      reviewActions,
      onRefreshRunStatus,
    }),
    [nodes, runStatus, reviewActions, onRefreshRunStatus],
  );
  return createElement(WorkflowRuntimeContext.Provider, { value }, children);
}

export function useWorkflowRuntime(): WorkflowRuntimeContextValue {
  return useContext(WorkflowRuntimeContext);
}

export function useWorkflowNodeRuntime(nodeId: string): WorkflowNodeRuntimeState {
  const { nodes } = useContext(WorkflowRuntimeContext);
  return nodes.get(nodeId) ?? defaultWorkflowNodeRuntimeState(nodeId);
}
