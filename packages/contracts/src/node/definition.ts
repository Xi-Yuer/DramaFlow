import { z } from 'zod';
import { contentIdentifierSchema } from '../data/reference.js';
import { runtimeValueMapSchema } from '../data/runtime-value.js';
import { nodeTypeIdSchema, nodeTypeVersionSchema } from './manifest.js';
import { workflowIdentifierSchema, workflowPortNameSchema } from '../workflow/metadata.js';

export const constantBindingSchema = z
  .object({ type: z.literal('constant'), value: z.json() })
  .strict();

export const workflowInputBindingSchema = z
  .object({ type: z.literal('workflow_input'), key: workflowPortNameSchema })
  .strict();

// 固定资产身份与版本；不读取资产、不检查权限或构造媒体运行值。
export const assetBindingSchema = z
  .object({
    type: z.literal('asset'),
    assetId: contentIdentifierSchema,
    versionId: contentIdentifierSchema,
  })
  .strict();

export const staticInputBindingSchema = z.discriminatedUnion('type', [
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
    inputs: z.record(workflowPortNameSchema, staticInputBindingSchema),
    config: z.record(z.string(), z.json()),
    preset: workflowIdentifierSchema.optional(),
    ui: z
      .object({
        position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
      })
      .strict(),
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

export const nodeRunStatusSchema = z.enum(['running', 'completed', 'failed']);

export const nodeExecutionStageSchema = z.enum([
  'create_run',
  'resolve_input',
  'record_inputs',
  'decode_input',
  'validate_input',
  'validate_config',
  'execute',
  'validate_output',
  'encode_output',
  'complete_run',
]);

export const nodeRunErrorSchema = z
  .object({ code: workflowIdentifierSchema, message: z.string(), stage: nodeExecutionStageSchema })
  .strict();

// 业务历史只保存 RuntimeValue；attempt 由 Repository 原子分配，时间沿用 JSON 协议。
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

export type ConstantBinding = z.infer<typeof constantBindingSchema>;
export type WorkflowInputBinding = z.infer<typeof workflowInputBindingSchema>;
export type AssetBinding = z.infer<typeof assetBindingSchema>;
export type StaticInputBinding = z.infer<typeof staticInputBindingSchema>;
export type NodeDefinition = z.infer<typeof nodeDefinitionSchema>;
export type NodePreset = z.infer<typeof nodePresetSchema>;
export type NodeRunError = z.infer<typeof nodeRunErrorSchema>;
export type NodeRun = z.infer<typeof nodeRunSchema>;
export type NodeRunStatus = z.infer<typeof nodeRunStatusSchema>;
export type NodeExecutionStage = z.infer<typeof nodeExecutionStageSchema>;
