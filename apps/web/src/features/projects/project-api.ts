import { z } from 'zod';
import { projectListSchema, projectSchema, type SaveProject } from '@dramaflow/contracts';
import { jsonBody, request } from '@/lib/http';

const saveResultSchema = z.object({ revision: z.number().int().positive() });

export const projectKeys = {
  list: ['projects'] as const,
  detail: (id: string) => ['projects', id] as const,
};

export const projectApi = {
  list: (cursor?: string) =>
    request(`/projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, projectListSchema),
  create: (name: string) =>
    request('/projects', projectSchema, { method: 'POST', body: jsonBody({ name }) }),
  get: (id: string) => request(`/projects/${id}`, projectSchema),
  save: (id: string, input: SaveProject) =>
    request(`/projects/${id}`, saveResultSchema, { method: 'PUT', body: jsonBody(input) }),
};
