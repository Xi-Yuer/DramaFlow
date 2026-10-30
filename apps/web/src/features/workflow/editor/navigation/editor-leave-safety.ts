import type { WorkflowRunState } from '../../run/workflow-run';

export interface EditorLeaveState {
  draftDirty: boolean;
  metadataDirty: boolean;
  draftOperation: 'idle' | 'saving' | 'reloading';
  savingMetadata: boolean;
  reloadingMetadata: boolean;
  publishing: boolean;
  run: WorkflowRunState;
  uncertainInvocation?: boolean;
}

function runRequestUnconfirmed(run: WorkflowRunState): boolean {
  if (run.phase === 'submitting') return true;
  if (run.phase !== 'error') return false;
  // 请求仍未确认时保护当前页面；持久恢复集合由 uncertainInvocation 同时参与判断。
  const error = run.error;
  if (!error || error.workflowRunId || error.code === 'WORKFLOW_QUEUE_UNAVAILABLE') return true;
  // 明确的 4xx 拒绝可离开；超时、网络、5xx、成功响应格式/身份异常均不能推定未受理。
  return error.status < 400 || error.status >= 500 || error.status === 408;
}

export function editorLeavingUnsafe(state: EditorLeaveState): boolean {
  return (
    state.draftDirty ||
    state.metadataDirty ||
    state.draftOperation !== 'idle' ||
    state.savingMetadata ||
    state.reloadingMetadata ||
    state.publishing ||
    state.uncertainInvocation === true ||
    runRequestUnconfirmed(state.run)
  );
}
