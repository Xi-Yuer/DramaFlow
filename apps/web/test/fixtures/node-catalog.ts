import {
  instantiateNodeCatalogEntry,
  nodeCatalogEntrySchema,
  type NodeCatalogEntry,
  type NodeDefinition,
  type NodeTypeManifest,
} from '@dramaflow/contracts';

// 仅供测试准备现有 Definition；生产条目由服务端独立声明。
export function createTestCatalogEntry(
  manifest: NodeTypeManifest,
  overrides: Partial<NodeCatalogEntry> = {},
): NodeCatalogEntry {
  return nodeCatalogEntrySchema.parse({
    id: `fixture_${manifest.type}_${manifest.version}`,
    metadata: {
      name: manifest.metadata.name,
      description: manifest.metadata.description,
      icon: manifest.metadata.icon,
    },
    category: 'data',
    exposure: 'public',
    target: { type: manifest.type, version: manifest.version },
    creation: {},
    ...overrides,
  });
}

export function createTestWorkflowNode(
  manifest: NodeTypeManifest,
  id: string,
  name: string,
  position: NodeDefinition['ui']['position'],
): NodeDefinition {
  return instantiateNodeCatalogEntry(createTestCatalogEntry(manifest), manifest, {
    id,
    name,
    position,
  });
}
