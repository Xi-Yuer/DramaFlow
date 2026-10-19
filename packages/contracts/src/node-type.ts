import { z } from 'zod';
import { workflowIdentifierSchema, workflowPortNameSchema } from './workflow.js';

const fieldLabel = {
  label: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
};

// 仅描述编辑提示，不携带 React 组件、脚本、密钥或服务端实例。
export const nodeFieldUISchema = z.discriminatedUnion('component', [
  z
    .object({
      ...fieldLabel,
      component: z.enum([
        'text',
        'textarea',
        'prompt-editor',
        'number',
        'switch',
        'asset-picker',
        'model-selector',
      ]),
    })
    .strict(),
  z
    .object({
      ...fieldLabel,
      component: z.literal('slider'),
      min: z.number().finite(),
      max: z.number().finite(),
      step: z.number().positive().finite().optional(),
    })
    .strict()
    .refine((field) => field.min <= field.max, '滑块最小值不能大于最大值'),
  z
    .object({
      ...fieldLabel,
      component: z.literal('select'),
      options: z
        .array(
          z
            .object({
              label: z.string().trim().min(1).max(80),
              value: z.union([z.string(), z.number().finite(), z.boolean()]),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
]);

export const nodeUISchema = z
  .object({
    icon: workflowIdentifierSchema.optional(),
    fields: z.record(workflowPortNameSchema, nodeFieldUISchema),
  })
  .strict();

export const nodeTypeMetadataSchema = z
  .object({
    type: workflowIdentifierSchema,
    preset: workflowIdentifierSchema.optional(),
    displayName: z.string().trim().min(1).max(80),
    category: workflowIdentifierSchema,
    ui: nodeUISchema,
  })
  .strict();

// JSON Schema 由服务端 Zod 官方转换器生成；本协议只校验可传输的 JSON 结构。
// Schema 的语义、引用与端口兼容仍由后续数据模型及服务端契约负责。
export const nodeTypeManifestSchema = nodeTypeMetadataSchema
  .extend({
    inputSchema: z.record(z.string(), z.json()),
    outputSchema: z.record(z.string(), z.json()),
    configSchema: z.record(z.string(), z.json()),
  })
  .strict();

export type NodeFieldUI = z.infer<typeof nodeFieldUISchema>;
export type NodeUI = z.infer<typeof nodeUISchema>;
export type NodeTypeMetadata = z.infer<typeof nodeTypeMetadataSchema>;
export type NodeTypeManifest = z.infer<typeof nodeTypeManifestSchema>;
