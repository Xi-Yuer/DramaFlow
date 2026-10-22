'use client';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkflowVersionListResponse, WorkflowVersionResponse } from '@dramaflow/contracts';
import { ApiError } from '../../lib/http';
import { workflowApi, workflowKeys } from './workflow-api';
import {
  WorkflowRunController,
  buildWorkflowRunInputs,
  workflowInputEditor,
  type WorkflowInputFormValue,
  type WorkflowInputFormValues,
} from './workflow-run';
import { workflowRunTrackingId } from './workflow-run-status';
import { useWorkflowRunStatus } from './use-workflow-run-status';

type PublishedVersion = WorkflowVersionListResponse['items'][number];

function initialInputValues(version: WorkflowVersionResponse): WorkflowInputFormValues {
  return Object.fromEntries(
    version.definition.inputs.map((definition) => {
      const editor = workflowInputEditor(definition.type);
      const value = editor.kind === 'string' ? '' : editor.kind === 'boolean' ? false : undefined;
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

export function useWorkflowRun(workflowId: string, preferredVersion: PublishedVersion | null) {
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
        start: workflowApi.startRun,
      }),
    [],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const runStatus = useWorkflowRunStatus(workflowRunTrackingId(state));
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
    const selected = version.data;
    if (!selected) return;
    const built = buildWorkflowRunInputs(selected.definition.inputs, values);
    if (!built.ok) return;
    await controller.startNew({
      workflowVersionId: selected.id,
      inputs: built.inputs,
    });
  }, [controller, values, version.data]);

  return {
    versions: availableVersions,
    selectedVersionId,
    version: version.data ?? null,
    versionsLoading: versions.isPending || versions.isFetching,
    versionLoading: version.isPending || version.isFetching,
    versionsError: versions.isError,
    versionError: version.isError,
    values,
    state,
    runStatus: runStatus.state,
    selectVersion,
    changeInput,
    run,
    retry: () => controller.retry(),
    refreshRunStatus: () => runStatus.refresh(),
    retryVersions: () => versions.refetch(),
    retryVersion: () => version.refetch(),
  };
}
