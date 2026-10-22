import {
  nodeDefinitionSchema,
  nodeTypeManifestSchema,
  type NodeDefinition,
  type NodeTypeManifest,
} from '@dramaflow/contracts';

// 实例身份和画布位置由 Editor 提供；这里只应用目录明确声明的默认配置。
export function createWorkflowNode(
  manifest: NodeTypeManifest,
  id: string,
  name: string,
  position: NodeDefinition['ui']['position'],
): NodeDefinition {
  const definition = nodeTypeManifestSchema.parse(manifest);
  return nodeDefinitionSchema.parse({
    id,
    type: definition.type,
    typeVersion: definition.version,
    name,
    inputs: {},
    config: Object.fromEntries(
      definition.config
        .filter((field) => field.defaultValue !== undefined)
        .map((field) => [field.key, field.defaultValue]),
    ),
    ui: { position },
  });
}
