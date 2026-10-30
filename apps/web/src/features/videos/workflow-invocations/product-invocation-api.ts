import type { StartWorkflowRunRequest } from '@dramaflow/contracts';
import {
  productWorkflowInvocationListSchema,
  productWorkflowInvocationLookupSchema,
  productWorkflowInvocationResponseSchema,
} from '@dramaflow/contracts';
import { jsonBody, request } from '@/lib/http';

const root = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;
export const productInvocationKeys = {
  history: (projectId: string, videoId: string) =>
    ['product-invocations', projectId, videoId] as const,
};
export const productInvocationApi = {
  start: (projectId: string, videoId: string, input: StartWorkflowRunRequest) =>
    request(
      `${root(projectId)}/videos/${encodeURIComponent(videoId)}/workflow-invocations`,
      productWorkflowInvocationResponseSchema,
      { method: 'POST', body: jsonBody(input) },
    ),
  list: (projectId: string, videoId: string, cursor?: string) =>
    request(
      `${root(projectId)}/videos/${encodeURIComponent(videoId)}/workflow-invocations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      productWorkflowInvocationListSchema,
    ),
  lookup: (projectId: string, key: string) =>
    request(
      `${root(projectId)}/workflow-invocations/by-key/${encodeURIComponent(key)}`,
      productWorkflowInvocationLookupSchema,
    ),
  get: (projectId: string, id: string) =>
    request(
      `${root(projectId)}/workflow-invocations/${encodeURIComponent(id)}`,
      productWorkflowInvocationResponseSchema,
    ),
};
