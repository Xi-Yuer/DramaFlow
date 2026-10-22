'use client';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { InvocationReceiptStore } from './invocation-receipts';
import { InvocationRecoveryController, type InvocationRecoveryState } from './invocation-recovery';
import { workflowApi } from '../../workflow-api';
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
) {
  const recovery = useMemo(
    () =>
      userId
        ? new InvocationRecoveryController(
            new InvocationReceiptStore(
              { userId, projectId, workflowId },
              () => window.localStorage,
            ),
            { lookup: workflowApi.lookupInvocation, start: workflowApi.startRun },
          )
        : null,
    [userId, projectId, workflowId],
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
