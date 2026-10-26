import { z } from 'zod';
import { workflowIdentifierSchema } from '../metadata.js';
import {
  nodeRunSchema,
  nodeRunStatusSchema,
  nodeRunErrorSchema,
  executionStructuralMetadataSchema,
} from './node-run.js';
import { workflowRunResponseSchema } from './workflow-run-api.js';

const reference = <T extends string>(type: T) =>
  z.object({ type: z.literal(type), id: workflowIdentifierSchema }).strict();
export const executionTreeRunRefSchema = reference('workflow_run');
export const executionTreeNodeRefSchema = reference('node_run');
export const executionTreeExecutionRefSchema = reference('child_execution');
export const executionTreeParentRefSchema = z.discriminatedUnion('type', [
  executionTreeRunRefSchema,
  executionTreeNodeRefSchema,
  executionTreeExecutionRefSchema,
]);

// 只读摘要；运行值仍经现有 NodeRun 查询读取，不把存储归属或完整 payload 带进 Tree。
export const executionTreeNodeSchema = nodeRunSchema
  .pick({
    id: true,
    nodeId: true,
    occurrenceId: true,
    attempt: true,
    status: true,
    startedAt: true,
    completedAt: true,
    error: true,
  })
  .extend({
    type: z.literal('node_run'),
    parent: z.discriminatedUnion('type', [
      executionTreeRunRefSchema,
      executionTreeExecutionRefSchema,
    ]),
  })
  .strict();

export const executionTreeExecutionSchema = z
  .object({
    type: z.literal('child_execution'),
    id: workflowIdentifierSchema,
    kind: workflowIdentifierSchema,
    parent: executionTreeNodeRefSchema,
    status: nodeRunStatusSchema,
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    error: nodeRunErrorSchema.optional(),
    metadata: executionStructuralMetadataSchema.optional(),
  })
  .strict();
export const executionTreeEntrySchema = z.discriminatedUnion('type', [
  executionTreeNodeSchema,
  executionTreeExecutionSchema,
]);
export const executionTreeRunSchema = workflowRunResponseSchema
  .pick({
    id: true,
    workflowId: true,
    workflowVersionId: true,
    status: true,
    createdAt: true,
    startedAt: true,
    completedAt: true,
    error: true,
  })
  .extend({ type: z.literal('workflow_run') })
  .strict();

export const executionTreeQuerySchema = z
  .object({
    parentType: z.enum(['workflow_run', 'node_run', 'child_execution']).default('workflow_run'),
    parentId: workflowIdentifierSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    after: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.parentType !== 'workflow_run' && value.parentId === undefined)
      context.addIssue({ code: 'custom', path: ['parentId'], message: '子层查询必须指定父条目' });
  });
export const executionTreeResponseSchema = z
  .object({
    run: executionTreeRunSchema,
    parent: executionTreeParentRefSchema,
    items: z.array(executionTreeEntrySchema).max(100),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type ExecutionTreeParentRef = z.infer<typeof executionTreeParentRefSchema>;
export type ExecutionTreeEntry = z.infer<typeof executionTreeEntrySchema>;
export type ExecutionTreeRun = z.infer<typeof executionTreeRunSchema>;
export type ExecutionTreeQuery = z.infer<typeof executionTreeQuerySchema>;
export type ExecutionTreeResponse = z.infer<typeof executionTreeResponseSchema>;
