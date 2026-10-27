import { z } from 'zod';
import { workflowIdentifierSchema, workflowPortNameSchema } from '../workflow/metadata.js';
import { compositeDefinitionSchema } from './composite.js';
import {
  nodeDefinitionSchema,
  staticInputBindingSchema,
  type NodeDefinition,
} from './definition.js';
import {
  nodeTypeIdSchema,
  nodeTypeManifestSchema,
  nodeTypeVersionSchema,
  type NodeTypeManifest,
} from './manifest.js';

export const nodeCatalogExposureSchema = z.enum(['public', 'advanced', 'internal']);
export const nodeCatalogCategorySchema = z.enum(['ai', 'data', 'workflow', 'advanced']);

// 产品条目有独立身份；多个条目可以创建同一个 Runtime 类型。
export const nodeCatalogEntrySchema = z
  .object({
    id: workflowIdentifierSchema,
    metadata: z
      .object({
        name: z.string().trim().min(1).max(80),
        description: z.string().max(500).optional(),
        icon: workflowIdentifierSchema.optional(),
      })
      .strict(),
    category: nodeCatalogCategorySchema,
    exposure: nodeCatalogExposureSchema,
    target: z.object({ type: nodeTypeIdSchema, version: nodeTypeVersionSchema }).strict(),
    // 纯数据创建描述，不是另一套 NodeDefinition 或可执行工厂。
    creation: z
      .object({
        config: z.record(z.string(), z.json()).optional(),
        inputs: z.record(workflowPortNameSchema, staticInputBindingSchema).optional(),
        composite: compositeDefinitionSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const nodeCatalogEntryListSchema = z
  .array(nodeCatalogEntrySchema)
  .superRefine((entries, context) => {
    const ids = new Set<string>();
    entries.forEach((entry, index) => {
      if (ids.has(entry.id))
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: '节点目录包含重复 Entry 身份',
        });
      ids.add(entry.id);
    });
  });

export type NodeCatalogEntry = z.infer<typeof nodeCatalogEntrySchema>;
export type NodeCatalogCategory = z.infer<typeof nodeCatalogCategorySchema>;
export type NodeCatalogExposure = z.infer<typeof nodeCatalogExposureSchema>;
export type NodeCatalogSurface = 'standard' | 'advanced';

export function isNodeCatalogEntryVisible(
  entry: NodeCatalogEntry,
  surface: NodeCatalogSurface = 'standard',
): boolean {
  return entry.exposure === 'public' || (surface === 'advanced' && entry.exposure === 'advanced');
}

// copy-on-create：只返回领域实例，调用方只负责实例 ID、名称覆盖和画布位置。
// 不解析来源引用、不执行能力；Draft / Publish 继续使用既有校验与准入。
export function instantiateNodeCatalogEntry(
  input: NodeCatalogEntry,
  target: NodeTypeManifest,
  instance: { id: string; position: NodeDefinition['ui']['position']; name?: string },
): NodeDefinition {
  const entry = nodeCatalogEntrySchema.parse(input);
  const manifest = nodeTypeManifestSchema.parse(target);
  if (entry.target.type !== manifest.type || entry.target.version !== manifest.version)
    throw new Error('Catalog Entry 与目标节点类型版本不匹配');
  const configDefaults = Object.fromEntries(
    manifest.config
      .filter((field) => field.defaultValue !== undefined)
      .map((field) => [field.key, field.defaultValue]),
  );
  return nodeDefinitionSchema.parse(
    structuredClone({
      id: instance.id,
      type: entry.target.type,
      typeVersion: entry.target.version,
      name: instance.name ?? entry.metadata.name,
      config: { ...configDefaults, ...entry.creation.config },
      inputs: entry.creation.inputs ?? {},
      ...(entry.creation.composite ? { composite: entry.creation.composite } : {}),
      ui: { position: instance.position },
    }),
  );
}
