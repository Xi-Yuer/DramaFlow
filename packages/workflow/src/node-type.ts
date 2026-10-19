import {
  nodeTypeDeclarationSchema,
  nodeTypeManifestSchema,
  type NodeTypeDeclaration,
  type NodeTypeManifest,
} from '@dramaflow/contracts';
import { z } from 'zod';
import { NodeContractError } from './node.js';

// 静态说明书与真实输入输出的 Zod 校验分离；配置 Schema 只在服务端持有。
export interface NodeTypeDefinition<
  ConfigSchema extends z.ZodObject = z.ZodObject,
> extends NodeTypeDeclaration {
  configSchema: ConfigSchema;
}

export interface NodeValueSchemas<
  InputSchema extends z.ZodObject = z.ZodObject,
  OutputSchema extends z.ZodObject = z.ZodObject,
> {
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
}

export function parseNodeTypeDefinition<ConfigSchema extends z.ZodObject>(
  definition: NodeTypeDefinition<ConfigSchema>,
): NodeTypeDefinition<ConfigSchema> {
  const declaration = nodeTypeDeclarationSchema.parse({
    type: definition.type,
    version: definition.version,
    metadata: definition.metadata,
    inputs: definition.inputs,
    outputs: definition.outputs,
    ...(definition.capabilities !== undefined ? { capabilities: definition.capabilities } : {}),
    ui: definition.ui,
  });
  for (const field of Object.keys(declaration.ui.config ?? {})) {
    if (!Object.hasOwn(definition.configSchema.shape, field)) {
      throw new NodeContractError('unknown_config_field', `UI 引用了未声明的配置字段：${field}`);
    }
  }
  return { ...declaration, configSchema: definition.configSchema };
}

// 只检查两种契约的端口名称一致；不从 Zod 猜测 DataType，也不创建媒体/领域值校验器。
export function assertNodePortSchemas(
  definition: NodeTypeDefinition,
  schemas: NodeValueSchemas,
): void {
  for (const [ports, schema] of [
    [definition.inputs, schemas.inputSchema],
    [definition.outputs, schemas.outputSchema],
  ] as const) {
    const names = new Set(ports.map((port) => port.key));
    if (
      names.size !== Object.keys(schema.shape).length ||
      Object.keys(schema.shape).some((key) => !names.has(key))
    ) {
      throw new NodeContractError('port_schema_mismatch', '声明端口与执行值 Schema 字段不一致');
    }
  }
}

export function createNodeTypeManifest(definitionInput: NodeTypeDefinition): NodeTypeManifest {
  const definition = parseNodeTypeDefinition(definitionInput);
  return nodeTypeManifestSchema.parse({
    type: definition.type,
    version: definition.version,
    metadata: definition.metadata,
    inputs: definition.inputs,
    outputs: definition.outputs,
    ...(definition.capabilities !== undefined ? { capabilities: definition.capabilities } : {}),
    ui: definition.ui,
    configSchema: z.toJSONSchema(definition.configSchema.strict(), {
      target: 'draft-2020-12',
      io: 'input',
      unrepresentable: 'throw',
      metadata: z.registry<Record<string, unknown>>(),
    }),
  });
}
