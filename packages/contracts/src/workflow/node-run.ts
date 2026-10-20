import { z } from 'zod';
import { runtimeValueMapSchema } from '../data/runtime-value.js';
import { workflowIdentifierSchema } from './metadata.js';

export const nodeRunStatusSchema = z.enum(['running', 'completed', 'failed']);

export const nodeRunErrorSchema = z
  .object({
    stage: workflowIdentifierSchema,
    code: workflowIdentifierSchema.optional(),
    message: z.string(),
  })
  .strict();

// 跨 API / Web / Worker 的 JSON 领域协议；attempt 由持久化层原子分配。
export const nodeRunSchema = z
  .object({
    id: workflowIdentifierSchema,
    workflowRunId: workflowIdentifierSchema,
    nodeId: workflowIdentifierSchema,
    attempt: z.number().int().positive(),
    status: nodeRunStatusSchema,
    inputs: runtimeValueMapSchema.optional(),
    outputs: runtimeValueMapSchema.optional(),
    error: nodeRunErrorSchema.optional(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
  })
  .strict();

export type NodeRunStatus = z.infer<typeof nodeRunStatusSchema>;
export type NodeRunError = z.infer<typeof nodeRunErrorSchema>;
export type NodeRun = z.infer<typeof nodeRunSchema>;
