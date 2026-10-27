import type { WorkflowRunState } from '../../run/workflow-run';

export interface EditorLeaveState {
  draftDirty: boolean;
  projectDirty: boolean;
  draftOperation: 'idle' | 'saving' | 'reloading';
  savingProject: boolean;
  reloadingProject: boolean;
  publishing: boolean;
  run: WorkflowRunState;
  uncertainInvocation?: boolean;
}

function runRequestUnconfirmed(run: WorkflowRunState): boolean {
  if (run.phase === 'submitting') return true;
  if (run.phase !== 'error') return false;
  // 运行身份目前只在页面内存中。已持久化但队列确认不明的请求仍需保护，恢复留给 R4。
  const error = run.error;
  if (!error || error.workflowRunId || error.code === 'WORKFLOW_QUEUE_UNAVAILABLE') return true;
  // 明确的 4xx 拒绝可离开；超时、网络、5xx、成功响应格式/身份异常均不能推定未受理。
  return error.status < 400 || error.status >= 500 || error.status === 408;
}

export function editorLeavingUnsafe(state: EditorLeaveState): boolean {
  return (
    state.draftDirty ||
    state.projectDirty ||
    state.draftOperation !== 'idle' ||
    state.savingProject ||
    state.reloadingProject ||
    state.publishing ||
    state.uncertainInvocation === true ||
    runRequestUnconfirmed(state.run)
  );
}
