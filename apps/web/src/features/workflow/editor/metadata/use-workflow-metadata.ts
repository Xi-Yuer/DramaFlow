import { useCallback, useRef, useState, type RefObject } from 'react';
import type { OnMove } from '@xyflow/react';
import { App } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { saveWorkflowMetadataRequestSchema, type WorkflowResponse } from '@dramaflow/contracts';
import { ApiError } from '@/lib/http';
import { workflowApi, workflowKeys } from '../../workflow-api';
import type { GraphCanvasSessionHandle } from '../navigation/graph-canvas-session';
import { clampViewport, draftSignature } from '../navigation/viewport';

export function useWorkflowMetadata(
  workflow: WorkflowResponse,
  graphSession: RefObject<GraphCanvasSessionHandle | null>,
) {
  const cache = useQueryClient();
  const { message, modal } = App.useApp();
  const [name, setName] = useState(workflow.name);
  const [viewport, setViewport] = useState(workflow.viewport);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [reloadingMetadata, setReloadingMetadata] = useState(false);
  const [revision, setRevision] = useState(workflow.metadataRevision);
  const [savedSignature, setSavedSignature] = useState(() =>
    draftSignature(workflow.name, workflow.viewport),
  );
  const signature = draftSignature(name, viewport);
  const dirty = signature !== savedSignature;

  const onMoveEnd = useCallback<OnMove>((_, next) => {
    const view = clampViewport(next);
    setViewport((current) =>
      current.x.toFixed(2) === view.x.toFixed(2) &&
      current.y.toFixed(2) === view.y.toFixed(2) &&
      current.zoom.toFixed(3) === view.zoom.toFixed(3)
        ? current
        : view,
    );
  }, []);

  const savingLock = useRef(false);
  const save = useCallback(async () => {
    if (savingLock.current || reloadingMetadata || conflict || !dirty) return;
    const trimmed = name.trim();
    if (!trimmed) {
      void message.error('请填写工作流名称');
      return;
    }
    const view = clampViewport(graphSession.current?.getRootViewport() ?? viewport);
    const payload = { expectedMetadataRevision: revision, name: trimmed, viewport: view };
    const parsed = saveWorkflowMetadataRequestSchema.safeParse(payload);
    if (!parsed.success) {
      void message.error(parsed.error.issues[0]?.message ?? '画布内容不符合保存协议');
      return;
    }
    savingLock.current = true;
    setSaving(true);
    setMetadataError(null);
    try {
      const result = await workflowApi.saveMetadata(workflow.projectId, workflow.id, parsed.data);
      setRevision(result.metadataRevision);
      setSavedSignature(draftSignature(trimmed, view));
      setConflict(false);
      cache.setQueryData<WorkflowResponse>(
        workflowKeys.detail(workflow.projectId, workflow.id),
        (current) =>
          current
            ? {
                ...current,
                name: trimmed,
                viewport: view,
                metadataRevision: result.metadataRevision,
              }
            : current,
      );
      void cache.invalidateQueries({ queryKey: workflowKeys.list(workflow.projectId) });
      void message.success('工作流信息已保存');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
        setMetadataError(error.message);
        return;
      }
      setMetadataError(error instanceof Error ? error.message : '工作流信息保存未确认');
    } finally {
      savingLock.current = false;
      setSaving(false);
    }
  }, [
    dirty,
    reloadingMetadata,
    conflict,
    message,
    name,
    workflow.id,
    workflow.projectId,
    revision,
    viewport,
    graphSession,
    cache,
  ]);

  function reloadMetadata() {
    const read = async () => {
      if (savingLock.current) return;
      savingLock.current = true;
      setReloadingMetadata(true);
      try {
        const result = await workflowApi.get(workflow.projectId, workflow.id);
        if (result.id !== workflow.id || result.projectId !== workflow.projectId)
          throw new ApiError('工作流信息响应与当前身份不匹配', 200);
        setName(result.name);
        setViewport(result.viewport);
        graphSession.current?.setRootViewport(result.viewport);
        setRevision(result.metadataRevision);
        setSavedSignature(draftSignature(result.name, result.viewport));
        setConflict(false);
        setMetadataError(null);
        cache.setQueryData(workflowKeys.detail(workflow.projectId, workflow.id), result);
      } catch (error) {
        setMetadataError(error instanceof Error ? error.message : '工作流信息读取失败');
      } finally {
        savingLock.current = false;
        setReloadingMetadata(false);
      }
    };
    if (!dirty) {
      void read();
      return;
    }
    modal.confirm({
      title: '重新读取工作流信息会放弃名称和视口修改',
      content: '当前工作流草稿的修改会保留。',
      okText: '读取服务器工作流信息',
      cancelText: '继续编辑',
      onOk: read,
    });
  }

  return {
    name,
    setName,
    viewport,
    saving,
    conflict,
    metadataError,
    reloadingMetadata,
    revision,
    dirty,
    onMoveEnd,
    save,
    reloadMetadata,
  };
}

export type WorkflowMetadata = ReturnType<typeof useWorkflowMetadata>;
