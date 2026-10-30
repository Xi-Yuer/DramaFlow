'use client';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { InvocationReceiptStore } from './invocation-receipts';
import { InvocationRecoveryController, type InvocationRecoveryState } from './invocation-recovery';
import { workflowApi } from '../../workflow-api';
import type { StartWorkflowRunRequest, WorkflowRunResponse } from '@dramaflow/contracts';
export interface InvocationRecoveryOptions {
  callerNamespace: string;
  start: (request: StartWorkflowRunRequest) => Promise<WorkflowRunResponse>;
  lookup: (workflowId: string, key: string) => Promise<{ run: WorkflowRunResponse | null }>;
}
const unavailable: InvocationRecoveryState = {
  checking: true,
  entries: [],
  selected: null,
  notice: null,
  storageError: false,
};
const noopSubscribe = () => () => {};
const unavailableSnapshot = () => unavailable;

export function useInvocationRecovery(
  userId: string | undefined,
  projectId: string,
  workflowId: string,
  options?: InvocationRecoveryOptions,
) {
  const callerNamespace = options?.callerNamespace;
  const lookup = options?.lookup ?? workflowApi.lookupInvocation;
  const start = options?.start ?? workflowApi.startRun;
  const recovery = useMemo(
    () =>
      userId
        ? new InvocationRecoveryController(
            new InvocationReceiptStore(
              {
                userId,
                projectId,
                workflowId,
                ...(callerNamespace ? { callerNamespace } : {}),
              },
              () => window.localStorage,
            ),
            {
              lookup,
              start,
            },
          )
        : null,
    [userId, projectId, workflowId, callerNamespace, lookup, start],
  );
  const state = useSyncExternalStore(
    recovery?.subscribe ?? noopSubscribe,
    recovery?.getSnapshot ?? unavailableSnapshot,
    unavailableSnapshot,
  );
  useEffect(() => {
    if (!recovery) return;
    void recovery.refresh();
    const changed = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && recovery.store.relevant(event.key))
        void recovery.refresh();
    };
    window.addEventListener('storage', changed);
    return () => {
      recovery.stop();
      window.removeEventListener('storage', changed);
    };
  }, [recovery]);
  return { recovery, state };
}
