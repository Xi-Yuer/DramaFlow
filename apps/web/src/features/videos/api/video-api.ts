import { z } from 'zod';
import {
  videoListSchema,
  videoSchema,
  saveVideoResultSchema,
  type SaveVideo,
} from '@dramaflow/contracts';
import { jsonBody, request } from '@/lib/http';

const root = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/videos`;
export const videoKeys = {
  list: (projectId: string) => ['videos', projectId, 'list'] as const,
  detail: (projectId: string, id: string) => ['videos', projectId, 'detail', id] as const,
};
export const videoApi = {
  list: (projectId: string, cursor?: string) =>
    request(
      `${root(projectId)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      videoListSchema,
    ),
  create: (projectId: string, name: string) =>
    request(root(projectId), videoSchema, {
      method: 'POST',
      body: jsonBody({ name }),
    }),
  get: (projectId: string, id: string) =>
    request(`${root(projectId)}/${encodeURIComponent(id)}`, videoSchema),
  save: (projectId: string, id: string, input: SaveVideo) =>
    request(`${root(projectId)}/${encodeURIComponent(id)}`, saveVideoResultSchema, {
      method: 'PUT',
      body: jsonBody(input),
    }),
  remove: (projectId: string, id: string) =>
    request(`${root(projectId)}/${encodeURIComponent(id)}`, z.null(), { method: 'DELETE' }),
};
