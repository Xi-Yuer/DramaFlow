import { z } from 'zod';
import { workflowDefinitionSchema } from './definition.js';
import { workflowMetadataSchema } from './metadata.js';

// 项目默认工作流是应用访问入口；身份、草稿和修订仍属于独立 Workflow。
export const initializeProjectWorkflowRequestSchema = z.object({}).strict().default({});
export const workflowResponseSchema = workflowMetadataSchema
  .extend({
    projectId: z.uuid(),
    revision: z.number().int().positive(),
    draft: workflowDefinitionSchema,
  })
  .strict();
export const saveWorkflowDraftRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    definition: workflowDefinitionSchema,
  })
  .strict();
export const saveWorkflowDraftResponseSchema = z
  .object({ revision: z.number().int().positive() })
  .strict();

export type WorkflowResponse = z.infer<typeof workflowResponseSchema>;
export type SaveWorkflowDraftRequest = z.infer<typeof saveWorkflowDraftRequestSchema>;
export type SaveWorkflowDraftResponse = z.infer<typeof saveWorkflowDraftResponseSchema>;
