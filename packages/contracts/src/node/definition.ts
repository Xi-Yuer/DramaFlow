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

export const nodeOutputVariableSourceSchema = z
  .object({
    type: z.literal('node_output'),
    nodeId: workflowIdentifierSchema,
    portKey: workflowPortNameSchema,
  })
  .strict();

export const workflowInputVariableSourceSchema = z
  .object({
    type: z.literal('workflow_input'),
    key: workflowPortNameSchema,
  })
  .strict();

export const templateVariableSourceSchema = z.discriminatedUnion('type', [
  nodeOutputVariableSourceSchema,
  workflowInputVariableSourceSchema,
]);

export const templateBindingSchema = z
  .object({
    type: z.literal('template'),
    value: z.string().min(1),
    variables: z.record(workflowPortNameSchema, templateVariableSourceSchema),
  })
  .strict();

export const candidateBindingSchema = z
  .object({
    type: z.literal('candidate'),
    sources: z.array(nodeOutputVariableSourceSchema),
  })
  .strict();

export const staticInputBindingSchema = z.discriminatedUnion('type', [
  constantBindingSchema,
  workflowInputBindingSchema,
  assetBindingSchema,
  templateBindingSchema,
  candidateBindingSchema,
]);

export function templateVariableNames(value: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)) {
    const name = match[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function templateHasLooseMarkers(value: string): boolean {
  const stripped = value.replace(/\{\{[A-Za-z][A-Za-z0-9_]*\}\}/g, '');
  return stripped.includes('{{') || stripped.includes('}}');
}

export function templateBindingMatches(
  value: string,
  variables: Readonly<Record<string, unknown>>,
) {
  const names = templateVariableNames(value);
  const keys = Object.keys(variables);
  return (
    keys.length > 0 &&
    !templateHasLooseMarkers(value) &&
    keys.length === names.length &&
    keys.every((key) => names.includes(key))
  );
}

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
  .strict()
  .superRefine((node, context) => {
    for (const [key, binding] of Object.entries(node.inputs)) {
      if (binding.type === 'candidate') {
        const seen = new Set<string>();
        binding.sources.forEach((source, index) => {
          const itemKey = JSON.stringify([source.nodeId, source.portKey]);
          if (seen.has(itemKey)) {
            context.addIssue({
              code: 'custom',
              path: ['inputs', key, 'sources', index],
              message: '候选输入来源不能重复',
            });
          }
          seen.add(itemKey);
        });
        continue;
      }
      if (binding.type !== 'template') continue;
      if (!templateBindingMatches(binding.value, binding.variables)) {
        context.addIssue({
          code: 'custom',
          path: ['inputs', key],
          message: '模板中的 {{名称}} 必须与变量来源一一对应',
        });
      }
    }
  });

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
export type NodeOutputVariableSource = z.infer<typeof nodeOutputVariableSourceSchema>;
export type TemplateVariableSource = z.infer<typeof templateVariableSourceSchema>;
export type TemplateBinding = z.infer<typeof templateBindingSchema>;
export type CandidateBinding = z.infer<typeof candidateBindingSchema>;
export type StaticInputBinding = z.infer<typeof staticInputBindingSchema>;
export type NodeDefinition = z.infer<typeof nodeDefinitionSchema>;
export type NodePreset = z.infer<typeof nodePresetSchema>;

export function templateNodeOutputDependencies(
  nodes: readonly Pick<NodeDefinition, 'id' | 'inputs'>[],
) {
  const dependencies: { sourceNodeId: string; targetNodeId: string }[] = [];
  for (const node of nodes) {
    for (const binding of Object.values(node.inputs)) {
      if (binding.type === 'candidate') {
        for (const source of binding.sources) {
          dependencies.push({ sourceNodeId: source.nodeId, targetNodeId: node.id });
        }
        continue;
      }
      if (binding.type !== 'template') continue;
      for (const source of Object.values(binding.variables)) {
        if (source.type === 'node_output')
          dependencies.push({ sourceNodeId: source.nodeId, targetNodeId: node.id });
      }
    }
  }
  return dependencies;
}
