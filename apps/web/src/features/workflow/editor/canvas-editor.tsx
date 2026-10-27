'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import '@xyflow/react/dist/style.css';
import type { Project, WorkflowResponse } from '@dramaflow/contracts';
import { ModelSettings } from '@/features/models/model-settings';
import {
  GraphCanvasSession,
  type GraphCanvasSessionHandle,
} from './navigation/graph-canvas-session';
import { useWorkflowPublish } from '../publish/use-workflow-publish';
import { useWorkflowRun } from '../run/use-workflow-run';
import { useEditorLeaveGuard } from './navigation/use-editor-leave-guard';
import { WorkflowPublishControls } from '../publish/workflow-publish-controls';
import { WorkflowExecutionWorkspace } from './workflow-execution-workspace';
import { workflowPublishDisabledReason } from './draft/workflow-draft-state';
import { useWorkflowDraft } from './draft/use-workflow-draft';
import { useProjectMetadata } from './project/use-project-metadata';
import { useEditorModelSettings } from './models/use-editor-model-settings';
import { EditorToolbar } from './presentation/editor-toolbar';
import { EditorNotices } from './presentation/editor-notices';

export function CanvasEditor({
  project,
  workflow,
}: {
  project: Project;
  workflow: WorkflowResponse;
}) {
  return <CanvasBoard key={workflow.id} project={project} workflow={workflow} />;
}

function CanvasBoard({ project, workflow }: { project: Project; workflow: WorkflowResponse }) {
  const router = useRouter();
  const graphSession = useRef<GraphCanvasSessionHandle>(null);
  const draft = useWorkflowDraft(workflow);
  const publication = useWorkflowPublish(draft);
  const workflowRun = useWorkflowRun(
    project.id,
    draft.workflowId,
    publication.latestPublishedVersion,
  );
  const metadata = useProjectMetadata(project, graphSession);
  const modelSettings = useEditorModelSettings();
  const { modelSettingsOpen, modelResume } = modelSettings;
  const { requestLeave } = useEditorLeaveGuard({
    draftDirty: draft.dirty,
    projectDirty: metadata.dirty,
    draftOperation: draft.operation,
    savingProject: metadata.saving,
    reloadingProject: metadata.reloadingProject,
    publishing: publication.publishing,
    run: workflowRun.state,
    uncertainInvocation: workflowRun.uncertainInvocation,
  });

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

  const publishDisabledReason =
    workflowPublishDisabledReason(draft, publication.publishing ? 'publishing' : draft.operation) ??
    (modelSettingsOpen
      ? '请先关闭模型设置'
      : publication.currentSavedRevisionPublished
        ? '当前保存修订已发布'
        : null);

  return (
    <main className="canvas-shell" onContextMenu={(event) => event.preventDefault()}>
      <EditorToolbar
        metadata={metadata}
        draft={draft}
        publishing={publication.publishing}
        onBack={() => requestLeave(() => router.push('/projects'))}
        onOpenModels={modelSettings.openSettings}
        requestLeave={requestLeave}
      />
      <EditorNotices metadata={metadata} draft={draft} publishing={publication.publishing} />
      <ModelSettings
        open={modelSettingsOpen}
        setupRequest={modelSettings.setupRequest}
        onIntentCancelled={modelSettings.cancelIntent}
        onIntentProviderReady={modelSettings.providerReady}
        onClose={modelSettings.closeSettings}
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
        <GraphCanvasSession
          ref={graphSession}
          key={draft.workflowId}
          projectId={project.id}
          workflowId={draft.workflowId}
          workflow={draft.definition}
          onEdit={draft.edit}
          onOpenProvider={modelSettings.openProvider}
          modelResume={modelResume}
          onModelResumeConsumed={modelSettings.consumeResume}
          reloading={draft.operation === 'reloading'}
          interactionLocked={modelSettingsOpen || publication.publishing}
          initialRootViewport={project.viewport}
          onRootViewportChange={metadata.onMoveEnd}
          runStatus={workflowRun.runStatus}
          nodeRuns={workflowRun.runStatus.nodeRuns}
          reviewActions={workflowRun.reviewActions}
          onRefreshRunStatus={() => void workflowRun.refreshRunStatus()}
        />
      </WorkflowExecutionWorkspace>
    </main>
  );
}
