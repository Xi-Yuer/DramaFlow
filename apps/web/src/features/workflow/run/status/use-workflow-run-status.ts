'use client';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { workflowApi } from '../../workflow-api';
import type { HumanReviewActions } from './workflow-run-status';
import { WorkflowRunStatusController } from './workflow-run-status';

export function useWorkflowRunStatus(
  runId: string | null,
  context?: { projectId: string; workflowId: string },
) {
  const projectId = context?.projectId,
    workflowId = context?.workflowId;
  const controller = useMemo(
    () =>
      new WorkflowRunStatusController({
        ...(projectId && workflowId
          ? { cancel: (target: string) => workflowApi.cancelRun(projectId, workflowId, target) }
          : {}),
        get: (target, signal) => workflowApi.getRun(target, signal),
        getPending: (target, signal) => workflowApi.getPendingHumanReviews(target, signal),
        getNodeRuns: (target, signal) => workflowApi.getNodeRuns(target, signal),
        resume: (target, input) => workflowApi.resumeRun(target, input),
      }),
    [projectId, workflowId],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    controller.watch(runId);
    return () => {
      if (runId) controller.stop(runId);
    };
  }, [controller, runId]);

  return {
    state,
    refresh: () => controller.refresh(),
    cancel: (target: string) => controller.cancel(target),
    reviewActions: {
      onFeedback: (identity, feedback) => controller.setFeedback(identity, feedback),
      onDecision: (identity, action) => void controller.submit(identity, action),
    } satisfies HumanReviewActions,
  };
}
