import { useCallback, useRef, useState, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import type { OnMove } from '@xyflow/react';
import { App } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { saveProjectSchema, type Project } from '@dramaflow/contracts';
import { ApiError } from '@/lib/http';
import { projectApi, projectKeys } from '@/features/projects/project-api';
import type { GraphCanvasSessionHandle } from '../navigation/graph-canvas-session';
import { clampViewport, draftSignature } from '../navigation/viewport';

export function useProjectMetadata(
  project: Project,
  graphSession: RefObject<GraphCanvasSessionHandle | null>,
) {
  const cache = useQueryClient();
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [name, setName] = useState(project.name);
  const [viewport, setViewport] = useState(project.viewport);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [reloadingProject, setReloadingProject] = useState(false);
  const [revision, setRevision] = useState(project.revision);
  const [savedSignature, setSavedSignature] = useState(() =>
    draftSignature(project.name, project.viewport),
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
    if (savingLock.current || reloadingProject || conflict || !dirty) return;
    const trimmed = name.trim();
    if (!trimmed) {
      void message.error('请填写项目名称');
      return;
    }
    const view = clampViewport(graphSession.current?.getRootViewport() ?? viewport);
    const payload = { revision, name: trimmed, viewport: view };
    const parsed = saveProjectSchema.safeParse(payload);
    if (!parsed.success) {
      void message.error(parsed.error.issues[0]?.message ?? '画布内容不符合保存协议');
      return;
    }
    savingLock.current = true;
    setSaving(true);
    setProjectError(null);
    try {
      const result = await projectApi.save(project.id, parsed.data);
      setRevision(result.revision);
      setSavedSignature(draftSignature(trimmed, view));
      setConflict(false);
      cache.setQueryData<Project>(projectKeys.detail(project.id), (current) =>
        current
          ? { ...current, name: trimmed, viewport: view, revision: result.revision }
          : current,
      );
      void cache.invalidateQueries({ queryKey: projectKeys.list, exact: true });
      void message.success('项目信息已保存');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
        setProjectError(error.message);
        return;
      }
      setProjectError(error instanceof Error ? error.message : '项目信息保存未确认');
    } finally {
      savingLock.current = false;
      setSaving(false);
    }
  }, [
    dirty,
    reloadingProject,
    conflict,
    message,
    name,
    project.id,
    revision,
    viewport,
    graphSession,
    cache,
  ]);

  function reloadProject() {
    const read = async () => {
      if (savingLock.current) return;
      savingLock.current = true;
      setReloadingProject(true);
      try {
        const result = await projectApi.get(project.id);
        setName(result.name);
        setViewport(result.viewport);
        graphSession.current?.setRootViewport(result.viewport);
        setRevision(result.revision);
        setSavedSignature(draftSignature(result.name, result.viewport));
        setConflict(false);
        setProjectError(null);
        cache.setQueryData(projectKeys.detail(project.id), result);
      } catch (error) {
        setProjectError(error instanceof Error ? error.message : '项目信息读取失败');
      } finally {
        savingLock.current = false;
        setReloadingProject(false);
      }
    };
    if (!dirty) {
      void read();
      return;
    }
    modal.confirm({
      title: '重新读取项目信息会放弃名称和视口修改',
      content: '当前工作流草稿的修改会保留。',
      okText: '读取服务器项目信息',
      cancelText: '继续编辑',
      onOk: read,
    });
  }

  function removeProject() {
    const label = name.trim() || project.name;
    modal.confirm({
      title: `删除「${label}」？`,
      content:
        '将删除该项目的视频作品、工作流、版本、运行记录、队列任务、Checkpoint 和已保存素材。账号中的模型配置会保留。此操作不能撤销。',
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await projectApi.remove(project.id);
          void message.success('项目已删除');
          router.push('/projects');
        } catch (error) {
          void message.error(error instanceof Error ? error.message : '项目删除未完成');
          if (error instanceof ApiError && (error.status === 404 || error.status === 503))
            router.push('/projects');
        }
      },
    });
  }

  return {
    name,
    setName,
    viewport,
    saving,
    conflict,
    projectError,
    reloadingProject,
    revision,
    dirty,
    onMoveEnd,
    save,
    reloadProject,
    removeProject,
  };
}

export type ProjectMetadata = ReturnType<typeof useProjectMetadata>;
