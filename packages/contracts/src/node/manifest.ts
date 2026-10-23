import { z } from 'zod';
import { dataTypeSchema } from '../data/type.js';
import { dataStoragePolicySchema } from '../data/manifest.js';
import { workflowIdentifierSchema, workflowPortNameSchema } from '../workflow/metadata.js';

export const nodeTypeIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/, '节点类型须使用稳定的英文命名空间标识');

export const nodeTypeVersionSchema = z.number().int().positive();

const displayNameSchema = z.string().trim().min(1).max(80);
const descriptionSchema = z.string().max(500);

export const nodeCategorySchema = z.enum([
  'input',
  'ai',
  'image',
  'video',
  'audio',
  'flow',
  'data',
  'output',
]);

export const nodeMetadataSchema = z
  .object({
    name: displayNameSchema,
    description: descriptionSchema.optional(),
    category: nodeCategorySchema,
    icon: workflowIdentifierSchema.optional(),
  })
  .strict();

// 一个端口当前只对应一条绑定。多来源聚合确定后再增加字段，避免目录声明和实例模型不一致。
export const inputPortDefinitionSchema = z
  .object({
    key: workflowPortNameSchema,
    name: displayNameSchema,
    description: descriptionSchema.optional(),
    dataType: dataTypeSchema,
    required: z.boolean().optional(),
  })
  .strict();

export const outputPortDefinitionSchema = z
  .object({
    key: workflowPortNameSchema,
    name: displayNameSchema,
    description: descriptionSchema.optional(),
    dataType: dataTypeSchema,
    storagePolicy: dataStoragePolicySchema.optional(),
  })
  .strict();

// 控制出口只命名路由，不承载 DataType / RuntimeValue。
export const controlOutputDefinitionSchema = z
  .object({
    key: workflowPortNameSchema,
    name: displayNameSchema,
    description: descriptionSchema.optional(),
  })
  .strict();

export const capabilityRequirementSchema = z.object({ type: nodeTypeIdSchema }).strict();

// 控件只保留公开提示；数值范围、选项与默认值统一由配置字段声明。
export const fieldUISchema = z
  .object({
    component: z.enum([
      'text',
      'textarea',
      'prompt-editor',
      'number',
      'switch',
      'select',
      'slider',
      'asset-picker',
      'model-selector',
    ]),
    placeholder: z.string().max(500).optional(),
  })
  .strict();

const configFieldBase = {
  key: workflowPortNameSchema,
  name: displayNameSchema,
  ui: fieldUISchema.optional(),
};

export const configFieldDefinitionSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...configFieldBase,
      type: z.literal('condition'),
      required: z.boolean().optional(),
      // 保留通用读取默认值的字段形状，但不开放默认表达式。
      defaultValue: z.never().optional(),
    })
    .strict(),
  z
    .object({
      ...configFieldBase,
      type: z.literal('string'),
      defaultValue: z.string().optional(),
      required: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...configFieldBase,
      type: z.literal('number'),
      defaultValue: z.number().finite().optional(),
      required: z.boolean().optional(),
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
    })
    .strict()
    .superRefine((field, context) => {
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
        context.addIssue({ code: 'custom', path: ['max'], message: '配置最小值不能大于最大值' });
      }
      if (
        field.defaultValue !== undefined &&
        ((field.min !== undefined && field.defaultValue < field.min) ||
          (field.max !== undefined && field.defaultValue > field.max))
      ) {
        context.addIssue({ code: 'custom', path: ['defaultValue'], message: '默认值超出配置范围' });
      }
    }),
  z
    .object({
      ...configFieldBase,
      type: z.literal('boolean'),
      defaultValue: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...configFieldBase,
      type: z.literal('select'),
      options: z.array(z.object({ label: displayNameSchema, value: z.string() }).strict()).min(1),
      defaultValue: z.string().optional(),
      required: z.boolean().optional(),
    })
    .strict()
    .superRefine((field, context) => {
      const values = new Set<string>();
      field.options.forEach((option, index) => {
        if (values.has(option.value)) {
          context.addIssue({
            code: 'custom',
            path: ['options', index, 'value'],
            message: '选项值不能重复',
          });
        }
        values.add(option.value);
      });
      if (field.defaultValue !== undefined && !values.has(field.defaultValue)) {
        context.addIssue({
          code: 'custom',
          path: ['defaultValue'],
          message: '默认值不属于配置选项',
        });
      }
    }),
]);

export const nodeUISchema = z
  .object({
    color: workflowIdentifierSchema.optional(),
    inputs: z.record(workflowPortNameSchema, fieldUISchema).optional(),
  })
  .strict();

// Manifest 是唯一公开类型说明书，所有字段均为 JSON，不持有 Zod、编译器或服务端实例。
export const nodeExecutionKindSchema = z.enum(['action', 'control', 'composite', 'interaction']);
export type NodeExecutionKind = z.infer<typeof nodeExecutionKindSchema>;

export const nodeTypeManifestSchema = z
  .object({
    type: nodeTypeIdSchema,
    version: nodeTypeVersionSchema,
    executionKind: nodeExecutionKindSchema,
    metadata: nodeMetadataSchema,
    inputs: z.array(inputPortDefinitionSchema),
    outputs: z.array(outputPortDefinitionSchema),
    controlOutputs: z.array(controlOutputDefinitionSchema).optional(),
    config: z.array(configFieldDefinitionSchema),
    capabilities: z.array(capabilityRequirementSchema).optional(),
    ui: nodeUISchema.optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const group of ['inputs', 'outputs', 'config', 'controlOutputs'] as const) {
      const keys = new Set<string>();
      manifest[group]?.forEach((item, index) => {
        if (keys.has(item.key)) {
          context.addIssue({
            code: 'custom',
            path: [group, index, 'key'],
            message: '同组字段 key 不能重复',
          });
        }
        keys.add(item.key);
      });
    }
    const capabilities = new Set<string>();
    manifest.capabilities?.forEach((capability, index) => {
      if (capabilities.has(capability.type)) {
        context.addIssue({
          code: 'custom',
          path: ['capabilities', index, 'type'],
          message: '不能重复声明同一能力类型',
        });
      }
      capabilities.add(capability.type);
    });
    const inputs = new Set(manifest.inputs.map((port) => port.key));
    for (const key of Object.keys(manifest.ui?.inputs ?? {})) {
      if (!inputs.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['ui', 'inputs', key],
          message: 'UI 引用了未声明的输入端口',
        });
      }
    }
  });

// 目录与显式连线共用同一边界，避免相同类型版本出现互相冲突的端口声明。
export const nodeTypeManifestListSchema = z
  .array(nodeTypeManifestSchema)
  .superRefine((manifests, context) => {
    const keys = new Set<string>();
    manifests.forEach((manifest, index) => {
      const key = JSON.stringify([manifest.type, manifest.version]);
      if (keys.has(key)) {
        context.addIssue({ code: 'custom', path: [index], message: '节点目录包含重复类型版本' });
      }
      keys.add(key);
    });
  });

export type NodeCategory = z.infer<typeof nodeCategorySchema>;
export type NodeMetadata = z.infer<typeof nodeMetadataSchema>;
export type InputPortDefinition = z.infer<typeof inputPortDefinitionSchema>;
export type OutputPortDefinition = z.infer<typeof outputPortDefinitionSchema>;
export type ControlOutputDefinition = z.infer<typeof controlOutputDefinitionSchema>;
export type CapabilityRequirement = z.infer<typeof capabilityRequirementSchema>;
export type FieldUI = z.infer<typeof fieldUISchema>;
export type ConfigFieldDefinition = z.infer<typeof configFieldDefinitionSchema>;
export type NodeUI = z.infer<typeof nodeUISchema>;
export type NodeTypeManifest = z.infer<typeof nodeTypeManifestSchema>;
