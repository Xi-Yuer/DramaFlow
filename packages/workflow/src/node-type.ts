import { nodeTypeManifestSchema, type NodeTypeManifest } from '@dramaflow/contracts';
import { z } from 'zod';
import { NodeContractError } from './node.js';

// 服务端真实值契约，不进入 Manifest、工作流定义或浏览器数据。
export interface NodeSchemas<
  InputSchema extends z.ZodObject = z.ZodObject,
  OutputSchema extends z.ZodObject = z.ZodObject,
  ConfigSchema extends z.ZodObject = z.ZodObject,
> {
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
  configSchema: ConfigSchema;
}

export function parseNodeManifest(input: unknown): NodeTypeManifest {
  return nodeTypeManifestSchema.parse(input);
}

export function assertNodeSchemas(manifest: NodeTypeManifest, schemas: NodeSchemas): void {
  for (const [ports, schema, code] of [
    [manifest.inputs, schemas.inputSchema, 'port_schema_mismatch'],
    [manifest.outputs, schemas.outputSchema, 'port_schema_mismatch'],
    [manifest.config, schemas.configSchema, 'config_schema_mismatch'],
  ] as const) {
    const names = new Set(ports.map((field) => field.key));
    const keys = Object.keys(schema.shape);
    if (names.size !== keys.length || keys.some((key) => !names.has(key))) {
      throw new NodeContractError(code, 'Manifest 声明与服务端值 Schema 字段不一致');
    }
  }
  // 公开默认值必须被对应的服务端字段接受；不会写入实例或注入运行 State。
  for (const field of manifest.config) {
    if (Object.hasOwn(field, 'defaultValue')) {
      z.json().parse(schemas.configSchema.shape[field.key]!.parse(field.defaultValue));
    }
  }
}
