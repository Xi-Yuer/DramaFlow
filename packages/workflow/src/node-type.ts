import {
  nodeTypeManifestSchema,
  nodeTypeMetadataSchema,
  workflowPortNameSchema,
  type NodeTypeManifest,
  type NodeTypeMetadata,
} from '@dramaflow/contracts';
import { z } from 'zod';
import { NodeContractError, type NodeContract } from './node.js';

export interface NodeTypeDefinition<
  InputSchema extends z.ZodObject = z.ZodObject,
  OutputSchema extends z.ZodObject = z.ZodObject,
  ConfigSchema extends z.ZodObject = z.ZodObject,
>
  extends NodeContract<InputSchema, OutputSchema, ConfigSchema>, NodeTypeMetadata {}

// 白名单复制公开元数据；Zod 保留服务端实例，不把任意服务端属性扩散到客户端。
export function parseNodeTypeDefinition<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodObject,
  ConfigSchema extends z.ZodObject,
>(
  definition: NodeTypeDefinition<InputSchema, OutputSchema, ConfigSchema>,
): NodeTypeDefinition<InputSchema, OutputSchema, ConfigSchema> {
  const metadata = nodeTypeMetadataSchema.parse({
    type: definition.type,
    preset: definition.preset,
    displayName: definition.displayName,
    category: definition.category,
    ui: definition.ui,
  });
  for (const schema of [definition.inputSchema, definition.outputSchema]) {
    for (const port of Object.keys(schema.shape)) workflowPortNameSchema.parse(port);
  }
  for (const field of Object.keys(metadata.ui.fields)) {
    if (!Object.hasOwn(definition.configSchema.shape, field)) {
      throw new NodeContractError('unknown_config_field', `UI 引用了未声明的配置字段：${field}`);
    }
  }
  return {
    ...metadata,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    configSchema: definition.configSchema,
  };
}

export function createNodeTypeManifest(definitionInput: NodeTypeDefinition): NodeTypeManifest {
  const definition = parseNodeTypeDefinition(definitionInput);
  const options = {
    target: 'draft-2020-12',
    unrepresentable: 'throw',
    // 不导出全局 .meta()，避免私有元数据或覆盖生成的校验类型。
    metadata: z.registry<Record<string, unknown>>(),
  } as const;
  return nodeTypeManifestSchema.parse({
    type: definition.type,
    preset: definition.preset,
    displayName: definition.displayName,
    category: definition.category,
    ui: definition.ui,
    inputSchema: z.toJSONSchema(definition.inputSchema.strict(), { ...options, io: 'input' }),
    configSchema: z.toJSONSchema(definition.configSchema.strict(), { ...options, io: 'input' }),
    outputSchema: z.toJSONSchema(definition.outputSchema.strict(), { ...options, io: 'output' }),
  });
}
