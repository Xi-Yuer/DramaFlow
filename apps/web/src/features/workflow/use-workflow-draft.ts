'use client';
import { useReducer, useRef } from 'react';
import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowResponse,
} from '@dramaflow/contracts';
import { ApiError } from '../../lib/http';
import { workflowApi } from './workflow-api';
import {
  createWorkflowDraftState,
  workflowDraftReducer,
  workflowDraftSignature,
} from './workflow-draft-state';

export function useWorkflowDraft(initial: WorkflowResponse) {
  const [state, dispatch] = useReducer(workflowDraftReducer, initial, createWorkflowDraftState);
  const current = useRef(initial.draft);
  const operation = useRef<'save' | 'reload' | null>(null);
  const dirty = workflowDraftSignature(state.definition) !== state.savedSignature;

  function edit(apply: (definition: WorkflowDefinition) => WorkflowDefinition) {
    if (operation.current === 'reload') return;
    try {
      const definition = workflowDefinitionSchema.parse(apply(current.current));
      current.current = definition;
      dispatch({ type: 'edit', definition });
    } catch (error) {
      dispatch({
        type: 'edit-failed',
        message: error instanceof Error ? error.message : '图修改未能应用',
      });
    }
  }

  async function save() {
    if (operation.current || state.conflict || !dirty) return;
    const snapshot = structuredClone(current.current);
    operation.current = 'save';
    dispatch({ type: 'save-started' });
    try {
      const result = await workflowApi.saveDraft(state.workflowId, {
        expectedRevision: state.revision,
        definition: snapshot,
      });
      dispatch({ type: 'save-succeeded', revision: result.revision, snapshot });
    } catch (error) {
      dispatch({
        type: 'save-failed',
        conflict: error instanceof ApiError && error.status === 409,
        message: error instanceof ApiError ? error.message : '草稿保存结果未确认，请检查网络后重试',
      });
    } finally {
      operation.current = null;
    }
  }

  async function reload() {
    if (operation.current) return;
    operation.current = 'reload';
    dispatch({ type: 'reload-started' });
    try {
      const workflow = await workflowApi.get(state.projectId);
      current.current = workflow.draft;
      dispatch({ type: 'reload-succeeded', workflow });
    } catch (error) {
      dispatch({
        type: 'reload-failed',
        message: error instanceof ApiError ? error.message : '服务器草稿读取失败，请检查网络后重试',
      });
    } finally {
      operation.current = null;
    }
  }

  return { ...state, dirty, edit, save, reload };
}
