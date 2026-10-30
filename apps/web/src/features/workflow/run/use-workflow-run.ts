'use client';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkflowVersionListResponse, WorkflowVersionResponse } from '@dramaflow/contracts';
import { App } from 'antd';
import { useIdentity } from '../../auth/use-identity';
import {
  useInvocationRecovery,
  type InvocationRecoveryOptions,
} from './recovery/use-invocation-recovery';
import { ApiError } from '../../../lib/http';
import { workflowApi, workflowKeys } from '../workflow-api';
import {
  WorkflowRunController,
  buildWorkflowRunInputs,
  workflowInputEditor,
  type WorkflowInputFormValue,
  type WorkflowInputFormValues,
} from './workflow-run';
import { workflowRunTrackingId } from './status/workflow-run-status';
import { useWorkflowRunStatus } from './status/use-workflow-run-status';

import type { WorkflowRunSummary } from '@dramaflow/contracts';

type PublishedVersion = WorkflowVersionListResponse['items'][number];

function initialInputValues(version: WorkflowVersionResponse): WorkflowInputFormValues {
  return Object.fromEntries(
    version.definition.inputs.map((definition) => {
      const editor = workflowInputEditor(definition.type);
      const value =
        editor.kind === 'array'
          ? []
          : editor.kind === 'string'
            ? ''
            : editor.kind === 'boolean'
              ? false
              : undefined;
      return [
        definition.name,
        {
          provided: definition.required,
          explicitNull: false,
          value,
        },
      ];
    }),
  );
}

export function useWorkflowRun(
  projectId: string,
  workflowId: string,
  preferredVersion: PublishedVersion | null,
  invocationOptions?: InvocationRecoveryOptions,
) {
  const queryClient = useQueryClient();
  const [historyRun, setHistoryRun] = useState<WorkflowRunSummary | null>(null);
  const historyVersion = useQuery({
    queryKey: workflowKeys.version(historyRun?.workflowVersionId ?? 'none'),
    enabled: !!historyRun,
    queryFn: async () => {
      if (!historyRun) throw new ApiError('尚未选择历史运行', 400);
      const result = await workflowApi.getVersion(historyRun.workflowVersionId);
      if (
        result.id !== historyRun.workflowVersionId ||
        result.workflowId !== workflowId ||
        result.projectId !== projectId
      )
        throw new ApiError('历史版本与当前工作流不匹配', 200);
      return result;
    },
    staleTime: Infinity,
  });
  const identity = useIdentity();
  const { modal } = App.useApp();
  const { recovery, state: recoveryState } = useInvocationRecovery(
    identity.data?.id,
    projectId,
    workflowId,
    invocationOptions,
  );
  const versions = useQuery({
    queryKey: workflowKeys.versions(workflowId),
    queryFn: async ({ signal }) => {
      const result = await workflowApi.listVersions(workflowId, signal);
      if (result.items.some((item) => item.workflowId !== workflowId))
        throw new ApiError('版本列表与当前工作流不匹配', 200);
      return result;
    },
  });
  const availableVersions = useMemo(() => {
    const listed = versions.data?.items ?? [];
    if (!preferredVersion || listed.some((item) => item.id === preferredVersion.id)) return listed;
    return [preferredVersion, ...listed];
  }, [preferredVersion, versions.data]);
  const preferredVersionId = preferredVersion?.id ?? null;
  const [selection, setSelection] = useState<{
    versionId: string;
    preferredVersionId: string | null;
  } | null>(null);
  const selectedVersionId =
    selection?.preferredVersionId === preferredVersionId
      ? selection.versionId
      : (preferredVersionId ?? availableVersions[0]?.id ?? null);

  const version = useQuery({
    queryKey: workflowKeys.version(selectedVersionId ?? 'none'),
    enabled: selectedVersionId !== null,
    queryFn: async () => {
      if (!selectedVersionId) throw new ApiError('尚未选择已发布版本', 400);
      const result = await workflowApi.getVersion(selectedVersionId);
      if (result.workflowId !== workflowId) throw new ApiError('所选版本与当前工作流不匹配', 200);
      return result;
    },
  });

  const controller = useMemo(
    () =>
      new WorkflowRunController({
        createInvocationKey: () => crypto.randomUUID(),
        start: (request) => {
          if (!recovery) throw new ApiError('尚未确认当前用户，运行请求尚未发送', 400);
          return recovery.submit(request);
        },
      }),
    [recovery],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const selectedRecovery = recoveryState.selected;
  const [trackingSelection, setTrackingSelection] = useState<string | null>(null);
  useEffect(() => {
    const confirmed = recoveryState.entries.find(
      (entry) => entry.run && entry.receipt.invocationKey === state.request?.invocationKey,
    )?.run;
    if (confirmed && state.phase === 'error') controller.confirm(confirmed);
  }, [controller, recoveryState.entries, state.phase, state.request]);
  const trackingId =
    trackingSelection ?? workflowRunTrackingId(state) ?? selectedRecovery?.id ?? null;
  const runStatus = useWorkflowRunStatus(trackingId, { projectId, workflowId });
  useEffect(() => {
    if (runStatus.state.run) recovery?.observe(runStatus.state.run);
  }, [recovery, runStatus.state.run]);
  const unresolved = recoveryState.entries.some((entry) => entry.phase !== 'found');
  const [form, setForm] = useState<{
    versionId: string | null;
    values: WorkflowInputFormValues;
  }>({ versionId: null, values: {} });
  const values =
    version.data && form.versionId !== version.data.id
      ? initialInputValues(version.data)
      : form.values;

  const selectVersion = useCallback(
    (versionId: string) => {
      setForm({ versionId: null, values: {} });
      setSelection({ versionId, preferredVersionId });
    },
    [preferredVersionId],
  );
  const changeInput = useCallback(
    (name: string, value: WorkflowInputFormValue) => {
      setForm({
        versionId: version.data?.id ?? null,
        values: { ...values, [name]: value },
      });
    },
    [values, version.data?.id],
  );
  const run = useCallback(async () => {
    if (recoveryState.checking || recoveryState.storageError) return;
    const selected = version.data;
    if (!selected) return;
    const built = buildWorkflowRunInputs(selected.definition.inputs, values);
    if (!built.ok) return;
    const submit = () => {
      setHistoryRun(null);
      setTrackingSelection(null);
      return controller.startNew({ workflowVersionId: selected.id, inputs: built.inputs });
    };
    if (unresolved || recoveryState.notice) {
      modal.confirm({
        title: '确认发起新的独立运行？',
        content: '上一次运行请求仍无法确认，新的运行可能与其同时执行。',
        okText: '发起新运行',
        cancelText: '取消',
        onOk: submit,
      });
    } else await submit();
  }, [
    controller,
    values,
    version.data,
    recoveryState.checking,
    recoveryState.storageError,
    recoveryState.notice,
    unresolved,
    modal,
  ]);

  const validHistoryVersion =
    historyRun &&
    historyVersion.data &&
    historyVersion.data.id === historyRun.workflowVersionId &&
    historyVersion.data.workflowId === workflowId &&
    historyVersion.data.projectId === projectId
      ? historyVersion.data
      : null;
  return {
    historyRun,
    historyVersion: validHistoryVersion,
    historyVersionError:
      historyVersion.isError || (!!historyRun && !!historyVersion.data && !validHistoryVersion),
    retryHistoryVersion: () => historyVersion.refetch(),
    selectHistoryRun: (run: WorkflowRunSummary) => {
      if (run.workflowId !== workflowId) return;
      setHistoryRun(run);
      setTrackingSelection(run.id);
    },
    returnToDraft: () => setHistoryRun(null),
    recovery: recoveryState,
    uncertainInvocation: unresolved,
    retryRecovery: () => recovery?.refresh(),
    selectRecovered: (key: string) => {
      setHistoryRun(null);
      recovery?.select(key);
      const run = recoveryState.entries.find((entry) => entry.receipt.invocationKey === key)?.run;
      if (run) setTrackingSelection(run.id);
    },
    versions: availableVersions,
    selectedVersionId,
    version: version.data ?? null,
    versionsLoading: versions.isPending || versions.isFetching,
    versionLoading: version.isPending || version.isFetching,
    versionsError: versions.isError,
    versionError: version.isError,
    values,
    state,
    runStatus:
      historyRun && runStatus.state.runId !== historyRun.id
        ? {
            ...runStatus.state,
            phase: 'loading' as const,
            runId: historyRun.id,
            run: null,
            nodeRuns: undefined,
            review: null,
            error: null,
          }
        : runStatus.state,
    reviewActions: runStatus.reviewActions,
    cancelRun: async (target: string) => {
      await runStatus.cancel(target);
      await queryClient.invalidateQueries({
        queryKey: workflowKeys.runHistory(projectId, workflowId),
      });
    },
    selectVersion,
    changeInput,
    run,
    retry: () => controller.retry(),
    refreshRunStatus: () => runStatus.refresh(),
    retryVersions: () => versions.refetch(),
    retryVersion: () => version.refetch(),
  };
}
