'use client';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { App } from 'antd';
import { modelApi, modelKeys } from '../model-api';
import type { FormState, ModelSettingsContentProps } from './model-settings-types';

export function useModelSettings({
  userId,
  setupRequest,
}: Pick<ModelSettingsContentProps, 'userId' | 'setupRequest'>) {
  const cache = useQueryClient(),
    { message } = App.useApp();
  const [tab, setTab] = useState('providers'),
    [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const locks = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const options = {
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always' as const,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  };
  const catalog = useQuery({
    ...options,
    queryKey: modelKeys.catalog,
    queryFn: ({ signal }) => modelApi.catalog(signal),
  });
  const definitions = useQuery({
    ...options,
    queryKey: modelKeys.providerCatalog,
    queryFn: ({ signal }) => modelApi.providerCatalog(signal),
  });
  const setupToken = setupRequest ? `${setupRequest.mode}:${setupRequest.definitionId}` : null;
  const [appliedSetup, setAppliedSetup] = useState<string | null>(null);
  if (definitions.data && setupToken !== appliedSetup) {
    setAppliedSetup(setupToken);
    if (
      setupRequest &&
      definitions.data.items.some((item) => item.id === setupRequest.definitionId)
    ) {
      setTab('providers');
      setForm(
        setupRequest.mode === 'configure'
          ? { kind: 'configure', definitionId: setupRequest.definitionId }
          : { kind: 'manage', definitionId: setupRequest.definitionId },
      );
    }
  }
  const providers = useQuery({
    ...options,
    queryKey: modelKeys.providers(userId),
    queryFn: ({ signal }) => modelApi.providers(signal),
  });
  const models = useQuery({
    ...options,
    queryKey: modelKeys.models(userId),
    queryFn: ({ signal }) => modelApi.models(signal),
  });
  const reading =
    catalog.isFetching || definitions.isFetching || providers.isFetching || models.isFetching;
  const readError = catalog.error || definitions.error || providers.error || models.error;
  async function refresh() {
    setError(null);
    await Promise.all([
      cache.invalidateQueries({ queryKey: modelKeys.catalog }),
      cache.invalidateQueries({ queryKey: modelKeys.providerCatalog }),
      cache.invalidateQueries({ queryKey: modelKeys.providers(userId) }),
      cache.invalidateQueries({ queryKey: modelKeys.models(userId) }),
    ]);
  }
  async function reloadResources() {
    await Promise.all([
      cache.invalidateQueries({ queryKey: modelKeys.providers(userId) }),
      cache.invalidateQueries({ queryKey: modelKeys.models(userId) }),
    ]);
  }
  async function action(id: string, apply: () => Promise<unknown>, success: string) {
    if (locks.current.has(id)) return;
    locks.current.add(id);
    setBusy(new Set(locks.current));
    setError(null);
    try {
      await apply();
      void message.success(success);
      await reloadResources();
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作未确认，请刷新列表核对');
    } finally {
      locks.current.delete(id);
      setBusy(new Set(locks.current));
    }
  }

  return {
    userId,
    cache,
    message,
    tab,
    setTab,
    form,
    setForm,
    busy,
    error,
    reading,
    readError,
    catalog,
    definitions,
    providers,
    models,
    refresh,
    reloadResources,
    action,
  };
}
