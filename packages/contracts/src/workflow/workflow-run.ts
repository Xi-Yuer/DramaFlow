import { z } from 'zod';
import { runtimeValueMapSchema } from '../data/runtime-value.js';
import { workflowIdentifierSchema, workflowRunMetadataSchema } from './metadata.js';

export { workflowRunStatusSchema, type WorkflowRunStatus } from './metadata.js';

export const workflowRunErrorSchema = z
  .object({
    stage: workflowIdentifierSchema,
    code: workflowIdentifierSchema.optional(),
    message: z.string(),
  })
  .strict();

// 完整 JSON 业务记录；outputs 仅保存对外结果，不是按节点组织的 State.outputs。
export const workflowRunSchema = workflowRunMetadataSchema.extend({
  projectId: workflowIdentifierSchema,
  inputs: runtimeValueMapSchema,
  outputs: runtimeValueMapSchema.optional(),
  error: workflowRunErrorSchema.optional(),
  createdAt: z.iso.datetime(),
});

export type WorkflowRunError = z.infer<typeof workflowRunErrorSchema>;
export type WorkflowRun = z.infer<typeof workflowRunSchema>;
