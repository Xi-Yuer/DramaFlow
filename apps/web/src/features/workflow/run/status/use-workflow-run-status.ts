'use client';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { workflowApi } from '../../workflow-api';
import { WorkflowRunStatusController } from './workflow-run-status';

export function useWorkflowRunStatus(runId: string | null) {
  const controller = useMemo(
    () =>
      new WorkflowRunStatusController({
        get: (target, signal) => workflowApi.getRun(target, signal),
      }),
    [],
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
  };
}
