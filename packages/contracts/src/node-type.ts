import { z } from 'zod';
import { dataTypeSchema } from './data-type.js';
import { workflowIdentifierSchema, workflowPortNameSchema } from './workflow.js';

export const nodeTypeIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/, '节点类型须使用稳定的英文命名空间标识');

export const nodeTypeVersionSchema = z.number().int().positive();

const portLabelSchema = z.string().trim().min(1).max(80);

export const inputPortDefinitionSchema = z
  .object({
    key: workflowPortNameSchema,
    name: portLabelSchema,
    dataType: dataTypeSchema,
    required: z.boolean().optional(),
    multiple: z.boolean().optional(),
    defaultValue: z.json().optional(),
  })
  .strict();

export const outputPortDefinitionSchema = z
  .object({
    key: workflowPortNameSchema,
    name: portLabelSchema,
    dataType: dataTypeSchema,
    multiple: z.boolean().optional(),
  })
  .strict();

export const capabilityRequirementSchema = z.object({ type: nodeTypeIdSchema }).strict();

export const nodeMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).optional(),
    category: workflowIdentifierSchema,
    icon: workflowIdentifierSchema.optional(),
  })
  .strict();

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
    color: workflowIdentifierSchema.optional(),
    inputs: z.record(workflowPortNameSchema, nodeFieldUISchema).optional(),
    config: z.record(workflowPortNameSchema, nodeFieldUISchema).optional(),
  })
  .strict();

export const nodeTypeDeclarationSchema = z
  .object({
    type: nodeTypeIdSchema,
    version: nodeTypeVersionSchema,
    metadata: nodeMetadataSchema,
    inputs: z.array(inputPortDefinitionSchema),
    outputs: z.array(outputPortDefinitionSchema),
    capabilities: z.array(capabilityRequirementSchema).optional(),
    ui: nodeUISchema,
  })
  .strict()
  .superRefine((definition, context) => {
    for (const direction of ['inputs', 'outputs'] as const) {
      const keys = new Set<string>();
      definition[direction].forEach((port, index) => {
        if (keys.has(port.key)) {
          context.addIssue({
            code: 'custom',
            path: [direction, index, 'key'],
            message: '同一方向不能声明重复端口',
          });
        }
        keys.add(port.key);
      });
    }

    const capabilities = new Set<string>();
    definition.capabilities?.forEach((capability, index) => {
      if (capabilities.has(capability.type)) {
        context.addIssue({
          code: 'custom',
          path: ['capabilities', index, 'type'],
          message: '不能重复声明同一能力类型',
        });
      }
      capabilities.add(capability.type);
    });

    const inputKeys = new Set(definition.inputs.map((port) => port.key));
    for (const key of Object.keys(definition.ui.inputs ?? {})) {
      if (!inputKeys.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['ui', 'inputs', key],
          message: 'UI 引用了未声明的输入端口',
        });
      }
    }
  });

// 端口公开稳定的 DataType；仅配置使用服务端 Zod 官方转换生成的 JSON Schema。
// 本协议不加载执行器，也不提供媒体或领域资料的运行值校验器。
export const nodeTypeManifestSchema = nodeTypeDeclarationSchema
  .safeExtend({ configSchema: z.record(z.string(), z.json()) })
  .strict();

export type InputPortDefinition = z.infer<typeof inputPortDefinitionSchema>;
export type OutputPortDefinition = z.infer<typeof outputPortDefinitionSchema>;
export type CapabilityRequirement = z.infer<typeof capabilityRequirementSchema>;
export type NodeMetadata = z.infer<typeof nodeMetadataSchema>;
export type NodeFieldUI = z.infer<typeof nodeFieldUISchema>;
export type NodeUI = z.infer<typeof nodeUISchema>;
export type NodeTypeDeclaration = z.infer<typeof nodeTypeDeclarationSchema>;
export type NodeTypeManifest = z.infer<typeof nodeTypeManifestSchema>;
