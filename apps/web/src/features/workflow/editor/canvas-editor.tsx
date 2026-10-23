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
import { WorkflowCanvas } from '@/features/workflow/canvas/workflow-canvas';
import type {
  ModelSelectionIntent,
  ModelSelectionResume,
} from '@/features/workflow/model-selection/model-selector';
import { useWorkflowPublish } from '@/features/workflow/publish/use-workflow-publish';
import { useWorkflowRun } from '@/features/workflow/run/use-workflow-run';
import { useEditorLeaveGuard } from '@/features/workflow/editor/use-editor-leave-guard';
import { WorkflowPublishControls } from '@/features/workflow/publish/workflow-publish-controls';
import { WorkflowExecutionWorkspace } from './workflow-execution-workspace';
import { workflowPublishDisabledReason } from '@/features/workflow/editor/workflow-draft-state';
import { useWorkflowDraft } from '@/features/workflow/editor/use-workflow-draft';
import { projectApi } from '../../projects/project-api';
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
      <CanvasBoard key={workflow.id} project={project} workflow={workflow} />
    </ReactFlowProvider>
  );
}

function CanvasBoard({ project, workflow }: { project: Project; workflow: WorkflowResponse }) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const { getViewport, setViewport: setCanvasViewport } = useReactFlow();
  const draft = useWorkflowDraft(workflow);
  const publication = useWorkflowPublish(draft);
  const workflowRun = useWorkflowRun(
    project.id,
    draft.workflowId,
    publication.latestPublishedVersion,
  );
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [setupRequest, setSetupRequest] = useState<{
    definitionId: string;
    mode: 'configure' | 'manage';
    intent: ModelSelectionIntent | null;
  } | null>(null);
  const [modelResume, setModelResume] = useState<ModelSelectionResume | null>(null);
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
  const { requestLeave } = useEditorLeaveGuard({
    draftDirty: draft.dirty,
    projectDirty: dirty,
    draftOperation: draft.operation,
    savingProject: saving,
    reloadingProject,
    publishing: publication.publishing,
    run: workflowRun.state,
    uncertainInvocation: workflowRun.uncertainInvocation,
  });

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

  const publishDisabledReason =
    workflowPublishDisabledReason(draft, publication.publishing ? 'publishing' : draft.operation) ??
    (modelSettingsOpen
      ? '请先关闭模型设置'
      : publication.currentSavedRevisionPublished
        ? '当前保存修订已发布'
        : null);

  return (
    <main className="canvas-shell" onContextMenu={(event) => event.preventDefault()}>
      <header className="canvas-top">
        <Button
          type="text"
          icon={<ArrowLeft size={16} />}
          onClick={() => requestLeave(() => router.push('/projects'))}
          aria-label="返回项目"
        >
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
            disabled={
              !draft.dirty ||
              draft.conflict ||
              draft.operation === 'reloading' ||
              publication.publishing
            }
            onClick={() => void draft.save()}
          >
            保存草稿
          </Button>
        </div>
        <div className="canvas-actions">
          <Button
            type="text"
            danger
            size="small"
            aria-label="删除项目"
            onClick={() => {
              const label = name.trim() || project.name;
              modal.confirm({
                title: `删除「${label}」？`,
                content:
                  '将删除该项目的工作流、版本、运行记录、队列任务、Checkpoint 和已保存素材。账号中的模型配置会保留。此操作不能撤销。',
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
            }}
          >
            删除项目
          </Button>
          <Button
            size="small"
            icon={<Settings2 size={15} />}
            disabled={publication.publishing}
            onClick={() => {
              setSetupRequest(null);
              setModelSettingsOpen(true);
            }}
          >
            模型设置
          </Button>
          <AccountMenuButton requestLeave={requestLeave} />
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
              disabled={draft.operation === 'saving' || publication.publishing}
              onClick={reloadDraft}
            >
              重新读取草稿
            </Button>
          }
        />
      ) : null}
      <ModelSettings
        open={modelSettingsOpen}
        setupRequest={setupRequest}
        onIntentCancelled={() =>
          setSetupRequest((current) => (current ? { ...current, intent: null } : null))
        }
        onIntentProviderReady={(provider) => {
          const intent = setupRequest?.intent;
          setModelSettingsOpen(false);
          setSetupRequest(null);
          if (intent && provider.providerDefinitionId === intent.providerDefinitionId) {
            setModelResume({ ...intent, providerId: provider.id, resumedAt: Date.now() });
          }
        }}
        onClose={() => {
          setModelSettingsOpen(false);
          setSetupRequest(null);
        }}
      />
      <WorkflowExecutionWorkspace
        publication={
          <WorkflowPublishControls
            compact
            revision={draft.revision}
            revisionConflict={draft.conflict}
            dirty={draft.dirty}
            disabledReason={publishDisabledReason}
            publishing={publication.publishing}
            current={publication.currentSavedRevisionPublished}
            latest={publication.latestPublishedVersion}
            error={publication.error}
            versionsError={publication.versions.isError || publication.refreshError !== null}
            versionsLoading={publication.versions.isPending || publication.versions.isFetching}
            onPublish={() => {
              if (!publishDisabledReason) void publication.publish();
            }}
            onRetryVersions={() => void publication.versions.refetch()}
          />
        }
        run={{
          versions: workflowRun.versions,
          selectedVersionId: workflowRun.selectedVersionId,
          version: workflowRun.version,
          versionsLoading: workflowRun.versionsLoading,
          versionLoading: workflowRun.versionLoading,
          submissionDisabled: workflowRun.recovery.checking || workflowRun.recovery.storageError,
          versionsError: workflowRun.versionsError,
          versionError: workflowRun.versionError,
          draftDirty:
            draft.dirty ||
            (publication.versions.isSuccess && !publication.currentSavedRevisionPublished),
          values: workflowRun.values,
          state: workflowRun.state,
          runStatus: workflowRun.runStatus,
          reviewActions: workflowRun.reviewActions,
          onSelectVersion: workflowRun.selectVersion,
          onChangeInput: workflowRun.changeInput,
          onRun: () => void workflowRun.run(),
          onRetry: () => void workflowRun.retry(),
          onRetryVersions: () => void workflowRun.retryVersions(),
          onRetryVersion: () => void workflowRun.retryVersion(),
          onRefreshRunStatus: () => void workflowRun.refreshRunStatus(),
        }}
        recovery={workflowRun.recovery}
        onRetryRecovery={() => void workflowRun.retryRecovery()}
        onSelectRecovered={workflowRun.selectRecovered}
      >
        <WorkflowCanvas
          key={draft.workflowId}
          projectId={project.id}
          workflow={draft.definition}
          onEdit={draft.edit}
          onOpenProvider={(definitionId, mode, intent) => {
            setSetupRequest({ definitionId, mode, intent: intent ?? null });
            setModelSettingsOpen(true);
          }}
          modelResume={modelResume}
          onModelResumeConsumed={() => setModelResume(null)}
          reloading={draft.operation === 'reloading'}
          interactionLocked={modelSettingsOpen || publication.publishing}
          defaultViewport={project.viewport}
          onMoveEnd={onMoveEnd}
        />
      </WorkflowExecutionWorkspace>
    </main>
  );
}
