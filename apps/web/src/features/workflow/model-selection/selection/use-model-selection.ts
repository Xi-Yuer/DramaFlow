'use client';
import { useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useIdentity } from '../../../auth/use-identity';
import { modelApi, modelKeys } from '../../../models/model-api';
import { WorkflowModelActionsContext, type ModelSelectorProps } from './model-selection-context';
import { resumeModelSelection } from './model-selector-options';
import { failure, useModelSelectionResources } from './model-selection-resources';

function useClient() {
  return useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
}

export function useModelSelection({ nodeId, capabilityTypes, value }: ModelSelectorProps) {
  const actions = useContext(WorkflowModelActionsContext);
  const identity = useIdentity();
  const userId = identity.data?.id ?? '';
  const cache = useQueryClient();
  const client = useClient();
  const hasValue = typeof value === 'string' && value.length > 0;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [addTarget, setAddTarget] = useState<{
    catalogId: string;
    displayName: string;
    providerId: string;
    capability: string;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [handledResumeId, setHandledResumeId] = useState<string | null>(null);
  const resume = actions?.resume?.nodeId === nodeId ? actions.resume : null;
  const resumeId = resume ? `${resume.providerId}:${resume.catalogId}` : null;
  const enabled =
    Boolean(actions) &&
    Boolean(userId) &&
    client &&
    capabilityTypes.length > 0 &&
    (open || hasValue || addTarget !== null || resume !== null);
  const { catalogQueries, definitions, providers, models } = useModelSelectionResources({
    capabilityTypes,
    userId,
    enabled,
    hasActions: Boolean(actions),
  });
  const resumeReady =
    resume !== null &&
    !actions?.disabled &&
    models.isSuccess &&
    providers.isSuccess &&
    !models.isFetching &&
    !providers.isFetching &&
    models.dataUpdatedAt >= resume.resumedAt &&
    providers.dataUpdatedAt >= resume.resumedAt &&
    (providers.data ?? []).some((item) => item.id === resume.providerId && item.enabled);
  const decision =
    resume && resumeReady
      ? resumeModelSelection({
          providerId: resume.providerId,
          catalogId: resume.catalogId,
          capability: resume.capability,
          configurations: models.data ?? [],
        })
      : null;
  const selectId = decision?.kind === 'select' ? decision.configurationId : null;
  if (decision && resume && resumeId && handledResumeId !== resumeId) {
    setHandledResumeId(resumeId);
    if (decision.kind === 'add') {
      setAddTarget({
        catalogId: resume.catalogId,
        displayName: resume.displayName,
        providerId: resume.providerId,
        capability: resume.capability,
      });
    }
    if (decision.kind === 'choose') {
      setOpen(true);
      setQuery(resume.displayName);
    }
  }
  const onSelectModel = actions?.onSelectModel;
  const onResumeConsumed = actions?.onResumeConsumed;
  useEffect(() => {
    if (!resumeId || handledResumeId !== resumeId || !onResumeConsumed) return;
    if (selectId) onSelectModel?.(nodeId, selectId);
    onResumeConsumed();
  }, [handledResumeId, nodeId, onResumeConsumed, onSelectModel, resumeId, selectId]);
  if (actions?.disabled && open) setOpen(false);

  function select(configurationId: string) {
    actions!.onSelectModel(nodeId, configurationId);
    setOpen(false);
    setQuery('');
  }

  async function enable(configurationId: string) {
    if (busyId) return;
    setBusyId(configurationId);
    setActionError(null);
    try {
      await modelApi.setModelEnabled(configurationId, true);
      await cache.invalidateQueries({ queryKey: modelKeys.models(userId) });
      select(configurationId);
    } catch (error) {
      setActionError(failure(error));
    } finally {
      setBusyId(null);
    }
  }

  function reload() {
    for (const item of catalogQueries) void item.refetch();
    void definitions.refetch();
    void providers.refetch();
    void models.refetch();
  }

  return {
    actions,
    userId,
    cache,
    client,
    hasValue,
    open,
    setOpen,
    query,
    setQuery,
    addTarget,
    setAddTarget,
    busyId,
    actionError,
    catalogQueries,
    definitions,
    providers,
    models,
    select,
    enable,
    reload,
  };
}
