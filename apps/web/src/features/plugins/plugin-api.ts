import { z } from 'zod';
import {
  installationSummarySchema,
  pluginManifestSchema,
  remoteModelListSchema,
  type InstallPlugin,
  type UpdateInstallation,
} from '@dramaflow/contracts';
import { jsonBody, request } from '@/lib/http';

const catalogSchema = z.object({ items: z.array(pluginManifestSchema) }).strict();
const listSchema = z.object({ items: z.array(installationSummarySchema) }).strict();
const removedSchema = z.object({ success: z.literal(true) }).strict();

export const pluginKeys = {
  catalog: ['plugins'] as const,
  installations: ['plugins', 'installations'] as const,
  models: (id: string) => ['plugins', 'installations', id, 'models'] as const,
};

export const pluginApi = {
  catalog: () => request('/plugins', catalogSchema),
  installations: () => request('/plugins/installations', listSchema),
  models: (id: string) => request(`/plugins/installations/${id}/models`, remoteModelListSchema),
  install: (input: InstallPlugin) =>
    request('/plugins/installations', installationSummarySchema, {
      method: 'POST',
      body: jsonBody(input),
    }),
  update: (id: string, input: UpdateInstallation) =>
    request(`/plugins/installations/${id}`, installationSummarySchema, {
      method: 'PUT',
      body: jsonBody(input),
    }),
  remove: (id: string) =>
    request(`/plugins/installations/${id}`, removedSchema, { method: 'DELETE' }),
};
