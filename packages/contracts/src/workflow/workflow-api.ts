import { z } from 'zod';
import {
  workflowDefinitionSchema,
  workflowDraftDefinitionSchema,
} from './definition/definition.js';
import { workflowMetadataSchema, workflowVersionMetadataSchema } from './metadata.js';
import { viewportSchema } from '../project.js';

export const workflowSummarySchema = workflowMetadataSchema
  .extend({
    projectId: z.uuid(),
    revision: z.number().int().positive(),
    metadataRevision: z.number().int().positive(),
  })
  .strict();
export const workflowResponseSchema = workflowSummarySchema.extend({
  draft: workflowDraftDefinitionSchema,
  viewport: viewportSchema,
});
export const createWorkflowRequestSchema = z
  .object({ name: workflowMetadataSchema.shape.name })
  .strict();
export const saveWorkflowMetadataRequestSchema = z
  .object({
    expectedMetadataRevision: z.number().int().positive(),
    name: workflowMetadataSchema.shape.name,
    viewport: viewportSchema.optional(),
  })
  .strict();
export const saveWorkflowMetadataResponseSchema = z
  .object({ metadataRevision: z.number().int().positive(), updatedAt: z.iso.datetime() })
  .strict();
export const workflowListQuerySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();
export const workflowListResponseSchema = z
  .object({
    items: z.array(workflowSummarySchema),
    nextCursor: workflowListQuerySchema.shape.cursor.unwrap().nullable(),
  })
  .strict();
export const deleteWorkflowRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    expectedMetadataRevision: z.number().int().positive(),
  })
  .strict();
const workflowCursorSchema = z
  .object({ id: z.uuid(), createdAt: z.iso.datetime({ precision: 3 }) })
  .strict();
export function encodeWorkflowCursor(cursor: z.infer<typeof workflowCursorSchema>): string {
  return btoa(JSON.stringify(workflowCursorSchema.parse(cursor)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
export function decodeWorkflowCursor(token: string): z.infer<typeof workflowCursorSchema> {
  const value = workflowListQuerySchema.shape.cursor
    .unwrap()
    .parse(token)
    .replaceAll('-', '+')
    .replaceAll('_', '/');
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(value + '='.repeat((4 - (value.length % 4)) % 4)));
  } catch {
    parsed = undefined;
  }
  return workflowCursorSchema.parse(parsed);
}
export const saveWorkflowDraftRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    definition: workflowDraftDefinitionSchema,
  })
  .strict();
export const saveWorkflowDraftResponseSchema = z
  .object({ revision: z.number().int().positive() })
  .strict();

export const publishWorkflowRequestSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
export const workflowVersionResponseSchema = workflowVersionMetadataSchema
  .extend({
    projectId: z.uuid(),
    sourceRevision: z.number().int().positive(),
    definition: workflowDefinitionSchema,
  })
  .strict();
export const workflowVersionSummarySchema = workflowVersionResponseSchema.omit({
  definition: true,
});
export const workflowVersionListQuerySchema = z
  .object({ beforeVersion: z.coerce.number().int().positive().optional() })
  .strict();
export const workflowVersionListResponseSchema = z
  .object({
    items: z.array(workflowVersionSummarySchema),
    nextBeforeVersion: z.number().int().positive().nullable(),
  })
  .strict();

export type WorkflowResponse = z.infer<typeof workflowResponseSchema>;
export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;
export type SaveWorkflowMetadataRequest = z.infer<typeof saveWorkflowMetadataRequestSchema>;
export type SaveWorkflowDraftRequest = z.infer<typeof saveWorkflowDraftRequestSchema>;
export type SaveWorkflowDraftResponse = z.infer<typeof saveWorkflowDraftResponseSchema>;
export type WorkflowVersionResponse = z.infer<typeof workflowVersionResponseSchema>;
export type WorkflowVersionListResponse = z.infer<typeof workflowVersionListResponseSchema>;
