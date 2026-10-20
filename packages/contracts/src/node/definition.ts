import { z } from 'zod';
import { contentIdentifierSchema } from '../data/reference.js';
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

export type ConstantBinding = z.infer<typeof constantBindingSchema>;
export type WorkflowInputBinding = z.infer<typeof workflowInputBindingSchema>;
export type AssetBinding = z.infer<typeof assetBindingSchema>;
export type StaticInputBinding = z.infer<typeof staticInputBindingSchema>;
export type NodeDefinition = z.infer<typeof nodeDefinitionSchema>;
export type NodePreset = z.infer<typeof nodePresetSchema>;
