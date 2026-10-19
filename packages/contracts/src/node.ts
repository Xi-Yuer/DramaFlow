import { z } from 'zod';
import { nodeTypeIdSchema, nodeTypeVersionSchema } from './node-type.js';
import { workflowIdentifierSchema, workflowPortNameSchema } from './workflow.js';

export const connectionBindingSchema = z
  .object({
    type: z.literal('connection'),
    nodeId: workflowIdentifierSchema,
    outputKey: workflowPortNameSchema,
  })
  .strict();

export const constantBindingSchema = z
  .object({ type: z.literal('constant'), value: z.json() })
  .strict();

export const workflowInputBindingSchema = z
  .object({ type: z.literal('workflow_input'), key: workflowPortNameSchema })
  .strict();

// 只声明资产标识；不读取资产、不检查权限或构造媒体运行值。
export const assetBindingSchema = z
  .object({ type: z.literal('asset'), assetId: workflowIdentifierSchema })
  .strict();

export const inputBindingSchema = z.discriminatedUnion('type', [
  connectionBindingSchema,
  constantBindingSchema,
  workflowInputBindingSchema,
  assetBindingSchema,
]);

export const nodeDefinitionSchema = z
  .object({
    id: workflowIdentifierSchema,
    type: nodeTypeIdSchema,
    typeVersion: nodeTypeVersionSchema,
    name: z.string().trim().min(1).max(80),
    inputs: z.record(workflowPortNameSchema, inputBindingSchema),
    config: z.record(z.string(), z.json()),
    preset: workflowIdentifierSchema.optional(),
    ui: z
      .object({
        position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
      })
      .strict(),
  })
  .strict();

// Workflow.edges 只保存控制关系；数据边由 Node.inputs.connection 派生。
export const controlEdgeDefinitionSchema = z
  .object({
    id: workflowIdentifierSchema,
    sourceNodeId: workflowIdentifierSchema,
    sourcePort: workflowPortNameSchema.optional(),
    targetNodeId: workflowIdentifierSchema,
  })
  .strict();

export const nodePresetSchema = z
  .object({
    id: workflowIdentifierSchema,
    type: nodeTypeIdSchema,
    typeVersion: nodeTypeVersionSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().optional(),
    config: z.record(z.string(), z.json()),
  })
  .strict();

export const nodeRunStatusSchema = z.enum([
  'pending',
  'ready',
  'running',
  'waiting',
  'completed',
  'failed',
  'skipped',
  'cancelled',
]);

export const nodeRunErrorSchema = z
  .object({ code: workflowIdentifierSchema, message: z.string() })
  .strict();

// 运行历史契约，尚非数据库 Store；快照仅校验 JSON，不代替 RuntimeValue、大小及脱敏策略。
// attempt 由后续运行服务分配，不在这里因恢复重入自动递增。
export const nodeRunSchema = z
  .object({
    id: workflowIdentifierSchema,
    workflowRunId: workflowIdentifierSchema,
    nodeId: workflowIdentifierSchema,
    attempt: z.number().int().positive(),
    status: nodeRunStatusSchema,
    inputSnapshot: z.record(z.string(), z.json()).optional(),
    outputSnapshot: z.record(z.string(), z.json()).optional(),
    error: nodeRunErrorSchema.optional(),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
  })
  .strict();

export type ConnectionBinding = z.infer<typeof connectionBindingSchema>;
export type ConstantBinding = z.infer<typeof constantBindingSchema>;
export type WorkflowInputBinding = z.infer<typeof workflowInputBindingSchema>;
export type AssetBinding = z.infer<typeof assetBindingSchema>;
export type InputBinding = z.infer<typeof inputBindingSchema>;
export type NodeDefinition = z.infer<typeof nodeDefinitionSchema>;
export type ControlEdgeDefinition = z.infer<typeof controlEdgeDefinitionSchema>;
export type NodePreset = z.infer<typeof nodePresetSchema>;
export type NodeRun = z.infer<typeof nodeRunSchema>;
export type NodeRunStatus = z.infer<typeof nodeRunStatusSchema>;
