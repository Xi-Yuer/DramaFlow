import { z } from 'zod';
import { runtimeValueMapSchema } from '../data/runtime-value.js';
import { workflowIdentifierSchema } from './metadata.js';

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

export const nodeRunStatusSchema = z.enum(['running', 'completed', 'failed']);

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
    iterationItemRunId: workflowIdentifierSchema.optional(),
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

// 只保存执行身份与生命周期；item 内容沿用输入 RuntimeValue / checkpoint，不复制 payload。
export const iterationItemRunSchema = z
  .object({
    id: workflowIdentifierSchema,
    workflowRunId: workflowIdentifierSchema,
    iterationNodeRunId: workflowIdentifierSchema,
    iterationNodeId: workflowIdentifierSchema,
    scopeKey: executionScopeKeySchema,
    index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    status: nodeRunStatusSchema,
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    error: nodeRunErrorSchema.optional(),
  })
  .strict();
export type IterationItemRun = z.infer<typeof iterationItemRunSchema>;
