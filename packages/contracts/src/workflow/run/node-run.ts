import { z } from 'zod';
import { runtimeValueMapSchema } from '../../data/runtime-value.js';
import { workflowIdentifierSchema, workflowPortNameSchema } from '../metadata.js';

export const ROOT_EXECUTION_SCOPE_KEY = 'root';
// 产品执行作用域标识，不是 LangGraph task / checkpoint namespace。
export const executionScopeKeySchema = workflowIdentifierSchema;
export const nodeOccurrenceSchema = z
  .object({
    id: workflowIdentifierSchema,
    workflowRunId: workflowIdentifierSchema,
    nodeId: workflowIdentifierSchema,
    scopeKey: executionScopeKeySchema,
  })
  .strict();
export type NodeOccurrence = z.infer<typeof nodeOccurrenceSchema>;

export const nodeRunStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);

export const nodeRunErrorSchema = z
  .object({
    stage: workflowIdentifierSchema,
    code: workflowIdentifierSchema.optional(),
    message: z.string(),
  })
  .strict();

// 跨 API / Web / Worker 的 JSON 领域协议；attempt 仅在 occurrence 内由持久化层原子分配。
export const nodeRunSchema = z
  .object({
    id: workflowIdentifierSchema,
    workflowRunId: workflowIdentifierSchema,
    nodeId: workflowIdentifierSchema,
    occurrenceId: workflowIdentifierSchema,
    scopeKey: executionScopeKeySchema,
    childExecutionId: workflowIdentifierSchema.optional(),
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

export const executionStructuralMetadataSchema = z
  .record(
    workflowPortNameSchema,
    z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]),
  )
  .refine((value) => Object.keys(value).length <= 16, '执行结构信息最多 16 项');

// Iteration-specific extension；不会要求其他 ChildExecution 具有 index。
export const iterationItemExecutionMetadataSchema = z.object({
  index: z.number().int().min(0).max(2147483647),
});

// 正式子图调用身份与生命周期；metadata 仅为结构信息，不复制 item payload。
export const childExecutionSchema = z
  .object({
    id: workflowIdentifierSchema,
    workflowRunId: workflowIdentifierSchema,
    parentNodeRunId: workflowIdentifierSchema,
    parentNodeId: workflowIdentifierSchema,
    scopeKey: executionScopeKeySchema,
    kind: workflowIdentifierSchema,
    invocationKey: workflowIdentifierSchema,
    metadata: executionStructuralMetadataSchema,
    status: nodeRunStatusSchema,
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    error: nodeRunErrorSchema.optional(),
  })
  .strict();
export type ChildExecution = z.infer<typeof childExecutionSchema>;
