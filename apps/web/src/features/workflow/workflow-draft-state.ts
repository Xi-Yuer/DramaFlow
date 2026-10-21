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
