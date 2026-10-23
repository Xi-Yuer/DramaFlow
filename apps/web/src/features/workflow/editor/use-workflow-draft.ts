'use client';
import { useCallback, useReducer, useRef } from 'react';
import {
  workflowDraftDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowResponse,
} from '@dramaflow/contracts';
import { ApiError } from '../../../lib/http';
import { workflowApi } from '../workflow-api';
import {
  createWorkflowDraftState,
  workflowDraftReducer,
  workflowDraftSignature,
  workflowPublishDisabledReason,
  type WorkflowDraftAction,
} from './workflow-draft-state';

export function useWorkflowDraft(initial: WorkflowResponse) {
  const [state, dispatch] = useReducer(workflowDraftReducer, initial, createWorkflowDraftState);
  const current = useRef(state);
  const operation = useRef<'saving' | 'reloading' | 'publishing' | null>(null);
  // 同步记录操作结果，避免同一事件循环中的保存 / 发布跨过 React 尚未提交的状态。
  const send = useCallback((action: WorkflowDraftAction) => {
    current.current = workflowDraftReducer(current.current, action);
    dispatch(action);
  }, []);
  const dirty = workflowDraftSignature(state.definition) !== state.savedSignature;

  const edit = useCallback(
    (apply: (definition: WorkflowDefinition) => WorkflowDefinition) => {
      if (operation.current === 'reloading' || operation.current === 'publishing') return;
      try {
        send({
          type: 'edit',
          definition: workflowDraftDefinitionSchema.parse(apply(current.current.definition)),
        });
      } catch (error) {
        send({
          type: 'edit-failed',
          message: error instanceof Error ? error.message : '图修改未能应用',
        });
      }
    },
    [send],
  );

  const save = useCallback(async () => {
    const before = current.current;
    if (
      operation.current ||
      before.conflict ||
      workflowDraftSignature(before.definition) === before.savedSignature
    )
      return;
    const snapshot = structuredClone(before.definition);
    operation.current = 'saving';
    send({ type: 'save-started' });
    try {
      const result = await workflowApi.saveDraft(before.workflowId, {
        expectedRevision: before.revision,
        definition: snapshot,
      });
      send({ type: 'save-succeeded', revision: result.revision, snapshot });
    } catch (error) {
      send({
        type: 'save-failed',
        conflict: error instanceof ApiError && error.status === 409,
        message: error instanceof ApiError ? error.message : '草稿保存结果未确认，请检查网络后重试',
      });
    } finally {
      operation.current = null;
    }
  }, [send]);

  const reload = useCallback(async () => {
    if (operation.current) return;
    operation.current = 'reloading';
    send({ type: 'reload-started' });
    try {
      const workflow = await workflowApi.get(current.current.projectId);
      send({ type: 'reload-succeeded', workflow });
    } catch (error) {
      send({
        type: 'reload-failed',
        message: error instanceof ApiError ? error.message : '服务器草稿读取失败，请检查网络后重试',
      });
    } finally {
      operation.current = null;
    }
  }, [send]);

  const beginPublish = useCallback(() => {
    const saved = current.current;
    if (workflowPublishDisabledReason(saved, operation.current ?? saved.operation)) return null;
    operation.current = 'publishing';
    return { workflowId: saved.workflowId, revision: saved.revision };
  }, []);
  const endPublish = useCallback(() => {
    if (operation.current === 'publishing') operation.current = null;
  }, []);
  const publishConflict = useCallback(
    (message: string) => send({ type: 'revision-conflict', message }),
    [send],
  );

  return { ...state, dirty, edit, save, reload, beginPublish, endPublish, publishConflict };
}
