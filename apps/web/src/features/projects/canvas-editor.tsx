'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ReactFlowProvider, useReactFlow, type OnMove } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Alert, App, Button } from 'antd';
import { ArrowLeft, Settings2 } from 'lucide-react';
import { saveProjectSchema, type Project, type WorkflowResponse } from '@dramaflow/contracts';
import { ApiError } from '@/lib/http';
import { AccountMenuButton } from '@/features/auth/account-menu';
import { ModelSettings } from '@/features/models/model-settings';
import { WorkflowCanvas } from '@/features/workflow/workflow-canvas';
import { useWorkflowDraft } from '@/features/workflow/use-workflow-draft';
import { projectApi } from './project-api';
import { clampViewport, draftSignature } from './viewport';

export function CanvasEditor({
  project,
  workflow,
}: {
  project: Project;
  workflow: WorkflowResponse;
}) {
  return (
    <ReactFlowProvider>
      <CanvasBoard project={project} workflow={workflow} />
    </ReactFlowProvider>
  );
}

function CanvasBoard({ project, workflow }: { project: Project; workflow: WorkflowResponse }) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const { getViewport, setViewport: setCanvasViewport } = useReactFlow();
  const draft = useWorkflowDraft(workflow);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [setupRequest, setSetupRequest] = useState<{
    definitionId: string;
    mode: 'configure' | 'manage';
  } | null>(null);
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
  const leavingDirty =
    dirty || draft.dirty || saving || reloadingProject || draft.operation !== 'idle';

  useEffect(() => {
    if (!leavingDirty) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [leavingDirty]);

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
    const view = clampViewport(getViewport());
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
  }, [dirty, reloadingProject, conflict, getViewport, message, name, project.id, revision]);

  const saveDraft = draft.save;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!modelSettingsOpen) void saveDraft();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveDraft, modelSettingsOpen]);

  function leave() {
    if (!leavingDirty) {
      router.push('/projects');
      return;
    }
    modal.confirm({
      title: '离开会放弃未保存或尚未确认保存的修改',
      okText: '离开',
      cancelText: '继续编辑',
      onOk: () => router.push('/projects'),
    });
  }

  function reloadProject() {
    const read = async () => {
      if (savingLock.current) return;
      savingLock.current = true;
      setReloadingProject(true);
      try {
        const result = await projectApi.get(project.id);
        setName(result.name);
        setViewport(result.viewport);
        void setCanvasViewport(result.viewport);
        setRevision(result.revision);
        setSavedSignature(draftSignature(result.name, result.viewport));
        setConflict(false);
        setProjectError(null);
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

  function reloadDraft() {
    if (!draft.dirty) {
      void draft.reload();
      return;
    }
    modal.confirm({
      title: '重新读取会放弃当前图修改',
      content: '项目名称和视口的修改会保留。',
      okText: '读取服务器草稿',
      cancelText: '继续编辑',
      onOk: draft.reload,
    });
  }

  return (
    <main className="canvas-shell" onContextMenu={(event) => event.preventDefault()}>
      <header className="canvas-top">
        <Button type="text" icon={<ArrowLeft size={16} />} onClick={leave} aria-label="返回项目">
          项目
        </Button>
        <input
          className="canvas-name"
          value={name}
          maxLength={80}
          aria-label="项目名称"
          onChange={(event) => setName(event.target.value)}
        />
        <div className="canvas-save-group" role="group" aria-label="项目信息">
          <span className="canvas-status" role="status" aria-label="项目信息状态">
            {saving
              ? '正在保存项目信息…'
              : reloadingProject
                ? '正在读取项目信息…'
                : conflict
                  ? '项目信息冲突'
                  : projectError
                    ? '项目信息保存未确认'
                    : dirty
                      ? '项目信息未保存'
                      : `项目已保存 · 修订 ${revision}`}
          </span>
          <Button
            size="small"
            loading={saving}
            disabled={!dirty || conflict || reloadingProject}
            onClick={() => void save()}
          >
            保存项目信息
          </Button>
        </div>
        <div className="canvas-save-group" role="group" aria-label="工作流草稿">
          <span className="canvas-status" role="status" aria-label="工作流草稿状态">
            {draft.operation === 'saving'
              ? '正在保存草稿…'
              : draft.operation === 'reloading'
                ? '正在读取服务器草稿…'
                : draft.conflict
                  ? '草稿修订冲突'
                  : draft.error
                    ? '草稿操作未完成'
                    : draft.dirty
                      ? '草稿未保存'
                      : `草稿已保存 · 修订 ${draft.revision}`}
          </span>
          <Button
            type="primary"
            size="small"
            title="保存草稿（⌘/Ctrl+S）"
            loading={draft.operation === 'saving'}
            disabled={!draft.dirty || draft.conflict || draft.operation === 'reloading'}
            onClick={() => void draft.save()}
          >
            保存草稿
          </Button>
        </div>
        <div className="canvas-actions">
          <Button
            size="small"
            icon={<Settings2 size={15} />}
            onClick={() => {
              setSetupRequest(null);
              setModelSettingsOpen(true);
            }}
          >
            模型设置
          </Button>
          <AccountMenuButton />
        </div>
      </header>
      {conflict || projectError ? (
        <Alert
          className="canvas-notice"
          showIcon
          type={conflict ? 'warning' : 'error'}
          title={conflict ? '项目信息已在其他页面更新' : '项目信息保存未确认'}
          description={`${projectError ?? ''} 当前本地修改仍保留。`}
          action={
            conflict ? (
              <Button
                size="small"
                loading={reloadingProject}
                disabled={saving}
                onClick={reloadProject}
              >
                重新读取项目信息
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {draft.conflict || draft.error ? (
        <Alert
          className="canvas-notice"
          showIcon
          type={draft.conflict ? 'warning' : 'error'}
          title={
            draft.conflict ? '服务器草稿已更新，本地修改仍保留' : '草稿操作未完成，本地修改仍保留'
          }
          description={
            draft.conflict
              ? '请重新读取服务器草稿后继续编辑，当前修改不会覆盖服务器的新版本。'
              : draft.error
          }
          action={
            <Button
              size="small"
              loading={draft.operation === 'reloading'}
              disabled={draft.operation === 'saving'}
              onClick={reloadDraft}
            >
              重新读取草稿
            </Button>
          }
        />
      ) : null}
      <ModelSettings
        open={modelSettingsOpen}
        projectId={project.id}
        projectName={name}
        setupRequest={setupRequest}
        onClose={() => {
          setModelSettingsOpen(false);
          setSetupRequest(null);
        }}
      />
      <WorkflowCanvas
        key={draft.workflowId}
        projectId={project.id}
        workflow={draft.definition}
        onEdit={draft.edit}
        onOpenProvider={(definitionId, mode) => {
          setSetupRequest({ definitionId, mode });
          setModelSettingsOpen(true);
        }}
        reloading={draft.operation === 'reloading'}
        interactionLocked={modelSettingsOpen}
        defaultViewport={project.viewport}
        onMoveEnd={onMoveEnd}
      />
    </main>
  );
}
