import {
  instantiateNodeCatalogEntry,
  nodeCatalogEntryListSchema,
  type NodeCatalogEntry,
} from '@dramaflow/contracts';
import { NodeRegistry } from '@dramaflow/workflow';

// 与 Runtime 注册表独立装配；注册新的 NodeType 不自动生成产品条目。
export class NodeCatalog {
  private readonly entries: NodeCatalogEntry[];

  constructor(entries: readonly NodeCatalogEntry[], registry: NodeRegistry) {
    this.entries = nodeCatalogEntryListSchema.parse(structuredClone(entries));
    for (const entry of this.entries) {
      const manifest = registry.get(entry.target.type, entry.target.version).manifest;
      instantiateNodeCatalogEntry(entry, manifest, {
        id: 'catalog_validation',
        position: { x: 0, y: 0 },
      });
    }
  }

  list(): NodeCatalogEntry[] {
    return structuredClone(this.entries);
  }
}

// 当前产品条目随部署发布；不提供业务 Composite 或数据库模板。
export function createBuiltinNodeCatalogEntries(): NodeCatalogEntry[] {
  return [
    {
      id: 'text-generation',
      metadata: { name: '文本生成', description: '使用明确选择的模型配置生成文本', icon: 'brain' },
      category: 'ai',
      exposure: 'public',
      target: { type: 'ai.text_generate', version: 1 },
      creation: {},
    },
    {
      id: 'conditional-branch',
      metadata: {
        name: '条件分支',
        description: '按字符串条件选择 true 或 false 分支',
        icon: 'flow',
      },
      category: 'workflow',
      exposure: 'advanced',
      target: { type: 'flow.if', version: 1 },
      creation: {},
    },
    {
      id: 'iteration',
      metadata: { name: '逐项处理', description: '逐项调用局部 Body 并聚合输出', icon: 'flow' },
      category: 'advanced',
      exposure: 'internal',
      target: { type: 'flow.iteration', version: 1 },
      creation: {},
    },
    {
      id: 'subworkflow',
      metadata: {
        name: '子流程',
        description: '封装可编辑的 Action DAG，声明输入输出后在当前版本内调用',
        icon: 'flow',
      },
      category: 'advanced',
      exposure: 'public',
      target: { type: 'flow.subworkflow', version: 1 },
      creation: {
        composite: {
          kind: 'subworkflow',
          graph: { inputs: [], nodes: [], edges: [], outputs: [] },
        },
      },
    },
    {
      id: 'human-review',
      metadata: { name: '人工审批', description: '审核文本并返回通过或拒绝结果', icon: 'flow' },
      category: 'workflow',
      exposure: 'public',
      target: { type: 'flow.human_review', version: 1 },
      creation: {},
    },
  ];
}
