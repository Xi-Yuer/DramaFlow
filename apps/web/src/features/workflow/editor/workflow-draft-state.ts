import type { WorkflowDefinition, WorkflowResponse } from '@dramaflow/contracts';

export interface WorkflowDraftState {
  workflowId: string;
  projectId: string;
  revision: number;
  definition: WorkflowDefinition;
  savedSignature: string;
  operation: 'idle' | 'saving' | 'reloading';
  conflict: boolean;
  error: string | null;
}

export const workflowDraftSignature = (definition: WorkflowDefinition) =>
  JSON.stringify(definition);

export function createWorkflowDraftState(workflow: WorkflowResponse): WorkflowDraftState {
  return {
    workflowId: workflow.id,
    projectId: workflow.projectId,
    revision: workflow.revision,
    definition: workflow.draft,
    savedSignature: workflowDraftSignature(workflow.draft),
    operation: 'idle',
    conflict: false,
    error: null,
  };
}

export type WorkflowDraftAction =
  | { type: 'revision-conflict'; message: string }
  | { type: 'edit'; definition: WorkflowDefinition }
  | { type: 'edit-failed'; message: string }
  | { type: 'save-started' }
  | { type: 'save-succeeded'; revision: number; snapshot: WorkflowDefinition }
  | { type: 'save-failed'; message: string; conflict: boolean }
  | { type: 'reload-started' }
  | { type: 'reload-succeeded'; workflow: WorkflowResponse }
  | { type: 'reload-failed'; message: string };

export function workflowDraftReducer(
  state: WorkflowDraftState,
  action: WorkflowDraftAction,
): WorkflowDraftState {
  switch (action.type) {
    case 'revision-conflict':
      return { ...state, conflict: true, error: action.message };
    case 'edit':
      return { ...state, definition: action.definition };
    case 'edit-failed':
      return { ...state, error: action.message };
    case 'save-started':
      return { ...state, operation: 'saving', error: null };
    case 'save-succeeded':
      // 只确认这次提交的快照；请求期间新增的本地编辑仍须另行保存。
      return {
        ...state,
        revision: action.revision,
        savedSignature: workflowDraftSignature(action.snapshot),
        operation: 'idle',
        conflict: false,
        error: null,
      };
    case 'save-failed':
      return { ...state, operation: 'idle', conflict: action.conflict, error: action.message };
    case 'reload-started':
      return { ...state, operation: 'reloading' };
    case 'reload-succeeded':
      return createWorkflowDraftState(action.workflow);
    case 'reload-failed':
      return { ...state, operation: 'idle', error: action.message };
  }
}

export function workflowPublishDisabledReason(
  state: WorkflowDraftState,
  operation: WorkflowDraftState['operation'] | 'publishing' = state.operation,
): string | null {
  if (operation === 'publishing') return '正在发布，请稍候';
  if (operation === 'saving') return '正在保存草稿，请等待保存完成';
  if (operation === 'reloading') return '正在读取服务器草稿';
  if (state.conflict) return '草稿修订冲突，请重新读取服务器草稿';
  if (state.error || !Number.isInteger(state.revision) || state.revision < 1)
    return '草稿状态尚未确认，请重新读取草稿';
  if (workflowDraftSignature(state.definition) !== state.savedSignature)
    return '请先保存草稿，再发布';
  return null;
}
