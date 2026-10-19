import { z } from 'zod';

export const viewportSchema = z
  .object({
    x: z.number().finite().min(-1_000_000).max(1_000_000),
    y: z.number().finite().min(-1_000_000).max(1_000_000),
    zoom: z.number().finite().min(0.1).max(3),
  })
  .strict();
export const createProjectSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export const saveProjectSchema = z
  .object({
    revision: z.number().int().positive(),
    name: createProjectSchema.shape.name,
    viewport: viewportSchema,
  })
  .strict();
export const projectSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    revision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const projectSchema = projectSummarySchema.extend({ viewport: viewportSchema });
export type Project = z.infer<typeof projectSchema>;
export type SaveProject = z.infer<typeof saveProjectSchema>;
