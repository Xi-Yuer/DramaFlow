import type { WorkflowRunResponse } from '@dramaflow/contracts';

export function currentExecutionKey(run: { waitingRevision: number }) {
  return run.waitingRevision === 0
    ? { kind: 'start', waitingRevision: 0 }
    : { kind: 'resume', waitingRevision: run.waitingRevision };
}

export function cancellationProjection(run: {
  status: string;
  waitingRevision: number;
  cancellationRequestedAt?: Date | null;
  executions?: readonly { kind: string; waitingRevision: number; status: string }[];
}): NonNullable<WorkflowRunResponse['cancellation']> {
  if (!run.cancellationRequestedAt || ['completed', 'failed', 'cancelled'].includes(run.status))
    return 'none';
  const key = currentExecutionKey(run);
  const current = run.executions?.find(
    (intent) => intent.kind === key.kind && intent.waitingRevision === key.waitingRevision,
  );
  if (current?.status === 'recovery_required' || (run.status === 'running' && !current))
    return 'uncertain';
  return 'requested';
}
