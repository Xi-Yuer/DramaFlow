import {
  CompositeDefinitionError,
  resolveNodePorts,
  type NodeDefinition,
  type NodeTypeManifest,
  type ResolvedNodePorts,
} from '@dramaflow/contracts';

// 只转发 contracts 的实例端口推导。缺少 composite 的草稿仍显示静态 Manifest，避免空 Iteration 卡片崩溃。
export function resolveWorkflowNodePorts(
  node: NodeDefinition,
  manifest: NodeTypeManifest,
): ResolvedNodePorts {
  try {
    return resolveNodePorts(node, manifest);
  } catch (error) {
    if (
      error instanceof CompositeDefinitionError &&
      error.code === 'ITERATION_DEFINITION_REQUIRED'
    ) {
      return { inputs: manifest.inputs, outputs: manifest.outputs };
    }
    throw error;
  }
}

export function findResolvedNodePorts(
  node: NodeDefinition | undefined,
  manifests: readonly NodeTypeManifest[],
): ResolvedNodePorts | undefined {
  if (!node) return undefined;
  const manifest = manifests.find(
    (item) => item.type === node.type && item.version === node.typeVersion,
  );
  if (!manifest) return undefined;
  return resolveWorkflowNodePorts(node, manifest);
}
