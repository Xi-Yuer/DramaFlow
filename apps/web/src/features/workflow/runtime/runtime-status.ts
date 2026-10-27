'use client';

import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react';
import type {
  NodeRun,
  NodeRunError,
  WorkflowDefinition,
  WorkflowRunResponse,
} from '@dramaflow/contracts';
import {
  directGraphNodeRuns,
  groupGraphNodeAttempts,
  type GraphExecutionProjection,
} from './graph-execution-projection';
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
  projection?: GraphExecutionProjection;
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

// 真实 NodeRun execution facts + PendingHumanReview 优先；不依赖 Workflow topology 猜测节点执行结果。
export function resolveWorkflowRuntimeNodes({
  workflow,
  runStatus,
  nodeRuns,
  projection,
}: WorkflowRuntimeInput): ReadonlyMap<string, WorkflowNodeRuntimeState> {
  const resolved = !projection || projection.phase === 'resolved';
  const run = resolved ? (runStatus?.run ?? null) : null;
  const atRoot =
    !projection || (projection.phase === 'resolved' && projection.instance.type === 'workflow_run');
  const review = resolved && atRoot ? (runStatus?.review ?? null) : null;
  const runRefreshing = runStatus?.refreshing ?? false;
  const runError = runStatus?.error ?? null;
  const effectiveNodeRuns = projection
    ? projection.phase === 'resolved'
      ? projection.nodeRuns
      : []
    : directGraphNodeRuns(nodeRuns ?? runStatus?.nodeRuns ?? [], {
        type: 'workflow_run',
        id: run?.id ?? '',
      });
  const groupedNodeRuns = groupGraphNodeAttempts(effectiveNodeRuns);
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
  projection?: GraphExecutionProjection;
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
  projection,
  runtimeNodes,
  reviewActions,
  onRefreshRunStatus,
  children,
}: {
  workflow: Pick<WorkflowDefinition, 'nodes' | 'edges'>;
  runStatus?: WorkflowRunStatusState | null;
  nodeRuns?: readonly NodeRun[];
  projection?: GraphExecutionProjection;
  runtimeNodes?: ReadonlyMap<string, WorkflowNodeRuntimeState>;
  reviewActions?: HumanReviewActions;
  onRefreshRunStatus?: () => void;
  children: ReactNode;
}) {
  const nodes = useMemo(
    () =>
      runtimeNodes ?? resolveWorkflowRuntimeNodes({ workflow, runStatus, nodeRuns, projection }),
    [workflow, runStatus, nodeRuns, projection, runtimeNodes],
  );
  const value = useMemo<WorkflowRuntimeContextValue>(
    () => ({
      nodes,
      runStatus,
      projection,
      reviewActions,
      onRefreshRunStatus,
    }),
    [nodes, runStatus, projection, reviewActions, onRefreshRunStatus],
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
