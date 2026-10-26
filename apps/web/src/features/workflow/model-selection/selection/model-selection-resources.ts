'use client';
import { useQueries, useQuery } from '@tanstack/react-query';
import { modelApi, modelKeys } from '../../../models/model-api';

export const queryOptions = {
  retry: false,
  staleTime: 0,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
};

export function failure(error: unknown) {
  return error instanceof Error ? error.message : '请求未完成';
}

export function useModelSelectionResources({
  capabilityTypes,
  userId,
  enabled,
  hasActions,
}: {
  capabilityTypes: readonly string[];
  userId: string;
  enabled: boolean;
  hasActions: boolean;
}) {
  const catalogQueries = useQueries({
    queries: capabilityTypes.map((capability) => ({
      ...queryOptions,
      queryKey: modelKeys.modelCatalog(capability),
      queryFn: ({ signal }: { signal: AbortSignal }) => modelApi.modelCatalog(capability, signal),
      enabled,
    })),
  });
  const definitions = useQuery({
    ...queryOptions,
    queryKey: modelKeys.providerCatalog,
    queryFn: ({ signal }) => modelApi.providerCatalog(signal),
    enabled,
  });
  const providers = useQuery({
    ...queryOptions,
    queryKey: modelKeys.providers(userId),
    queryFn: ({ signal }) => modelApi.providers(signal),
    enabled: enabled && hasActions,
  });
  const models = useQuery({
    ...queryOptions,
    queryKey: modelKeys.models(userId),
    queryFn: ({ signal }) => modelApi.models(signal),
    enabled: enabled && hasActions,
  });
  return { catalogQueries, definitions, providers, models };
}
