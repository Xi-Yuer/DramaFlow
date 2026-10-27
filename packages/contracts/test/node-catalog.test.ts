import { describe, expect, it } from 'vitest';
import {
  StringType,
  instantiateNodeCatalogEntry,
  isNodeCatalogEntryVisible,
  nodeCatalogEntryListSchema,
  nodeCatalogEntrySchema,
  nodeDefinitionSchema,
  nodeTypeManifestSchema,
  workflowDraftDefinitionSchema,
  type NodeCatalogEntry,
} from '../src/index.js';

const action = nodeTypeManifestSchema.parse({
  type: 'test.action',
  version: 7,
  executionKind: 'action',
  metadata: { name: 'Runtime 操作', category: 'data' },
  inputs: [{ key: 'value', name: '值', dataType: { kind: 'any' } }],
  outputs: [],
  config: [
    { key: 'count', name: '次数', type: 'number', defaultValue: 0 },
    { key: 'enabled', name: '启用', type: 'boolean', defaultValue: false },
    { key: 'label', name: '标签', type: 'string', defaultValue: '' },
    { key: 'required', name: '必填项', type: 'string', required: true },
  ],
});
const subworkflow = nodeTypeManifestSchema.parse({
  type: 'flow.subworkflow',
  version: 1,
  executionKind: 'composite',
  portDerivation: 'subworkflow',
  metadata: { name: '子流程', category: 'flow' },
  inputs: [],
  outputs: [],
  config: [],
});
const entry = (): NodeCatalogEntry =>
  nodeCatalogEntrySchema.parse({
    id: 'fixture-action',
    metadata: { name: '产品操作', description: '不同于 Runtime 名称' },
    category: 'data',
    exposure: 'public',
    target: { type: action.type, version: action.version },
    creation: {},
  });
function compositeEntry(): NodeCatalogEntry {
  return nodeCatalogEntrySchema.parse({
    ...entry(),
    id: 'fixture-composite',
    target: { type: subworkflow.type, version: 1 },
    creation: {
      inputs: { prompt: { type: 'constant', value: '初始输入' } },
      composite: {
        kind: 'subworkflow',
        graph: {
          inputs: [{ name: 'prompt', type: StringType, required: true }],
          nodes: [
            {
              id: 'inside',
              type: 'test.action',
              typeVersion: 7,
              name: '内部操作',
              config: { count: 2 },
              inputs: { value: { type: 'workflow_input', key: 'prompt' } },
              ui: { position: { x: 1, y: 2 } },
            },
          ],
          edges: [],
          outputs: [],
        },
      },
    },
  });
}
const instance = { id: 'node_a', position: { x: -12.5, y: 42 } };

describe('Catalog Entry 与通用实例化', () => {
  it('产品身份独立；多个 Entry 可以 target 同一精确 Runtime 类型版本', () => {
    const first = entry(),
      second = { ...entry(), id: 'fixture-alternative', metadata: { name: '另一产品操作' } };
    expect(first.id).not.toBe(first.target.type);
    expect(nodeCatalogEntryListSchema.parse([first, second])).toHaveLength(2);
    expect(() => nodeCatalogEntryListSchema.parse([first, first])).toThrow('重复 Entry');
    expect(instantiateNodeCatalogEntry(first, action, instance).name).toBe('产品操作');
    expect(instantiateNodeCatalogEntry(second, action, instance).name).toBe('另一产品操作');
  });

  it('普通 Action 合并 Manifest 默认配置和 Entry 覆盖，支持默认 inputs 与名称覆盖', () => {
    const source = entry();
    source.creation = {
      config: { count: 3 },
      inputs: { value: { type: 'constant', value: { nested: ['初始值'] } } },
    };
    const node = instantiateNodeCatalogEntry(source, action, { ...instance, name: '用户名称' });
    expect(node).toEqual({
      id: 'node_a',
      type: 'test.action',
      typeVersion: 7,
      name: '用户名称',
      config: { count: 3, enabled: false, label: '' },
      inputs: source.creation.inputs,
      ui: { position: instance.position },
    });
    expect(nodeDefinitionSchema.parse(node)).toEqual(node);
    expect(node).not.toHaveProperty('entryId');
    expect(node).not.toHaveProperty('preset');
    expect(node.config).not.toHaveProperty('required');
    const second = instantiateNodeCatalogEntry(source, action, { ...instance, id: 'second' });
    const binding = node.inputs.value;
    if (
      binding?.type !== 'constant' ||
      !binding.value ||
      typeof binding.value !== 'object' ||
      Array.isArray(binding.value) ||
      !Array.isArray(binding.value.nested)
    )
      throw new Error('缺少测试输入');
    binding.value.nested.push('深层修改');
    expect(second.inputs).toEqual(source.creation.inputs);
    node.inputs.value = { type: 'constant', value: '已修改' };
    expect(source.creation.inputs?.value).toEqual({
      type: 'constant',
      value: { nested: ['初始值'] },
    });
  });

  it('SubWorkflow composite 以独立副本创建，Entry、另一个实例及后续 Entry 更新相互隔离', () => {
    const source = compositeEntry(),
      original = structuredClone(source);
    const a = instantiateNodeCatalogEntry(source, subworkflow, instance);
    const b = instantiateNodeCatalogEntry(source, subworkflow, { ...instance, id: 'node_b' });
    if (
      a.composite?.kind !== 'subworkflow' ||
      b.composite?.kind !== 'subworkflow' ||
      source.creation.composite?.kind !== 'subworkflow'
    )
      throw new Error('缺少子图');
    expect(a.composite.graph).not.toBe(source.creation.composite.graph);
    a.composite.graph.nodes[0]!.config.count = 9;
    a.composite.graph.nodes[0]!.inputs.value = { type: 'constant', value: '实例修改' };
    a.composite.graph.inputs[0]!.name = 'renamed';
    a.ui.position.x = 999;
    expect(b.composite).toEqual(original.creation.composite);
    expect(source).toEqual(original);
    expect(instance.position.x).toBe(-12.5);
    source.creation.composite.graph.nodes[0]!.name = '新版条目';
    expect(b.composite.graph.nodes[0]!.name).toBe('内部操作');
    const definition = { inputs: [], nodes: [b], edges: [], outputs: [] };
    expect(workflowDraftDefinitionSchema.parse(JSON.parse(JSON.stringify(definition)))).toEqual(
      definition,
    );
  });

  it('contract 拒绝错误 target、非法 composite / 内部图，不向 Manifest 增加图字段', () => {
    expect(() => instantiateNodeCatalogEntry(entry(), { ...action, version: 8 }, instance)).toThrow(
      '类型版本不匹配',
    );
    expect(() =>
      instantiateNodeCatalogEntry(
        { ...compositeEntry(), target: entry().target },
        action,
        instance,
      ),
    ).toThrow('composite kind');
    const invalid = compositeEntry();
    if (invalid.creation.composite?.kind !== 'subworkflow') throw new Error('缺少子图');
    invalid.creation.composite.graph.nodes.push(
      structuredClone(invalid.creation.composite.graph.nodes[0]!),
    );
    expect(() => instantiateNodeCatalogEntry(invalid, subworkflow, instance)).toThrow();
    expect(nodeTypeManifestSchema.safeParse({ ...subworkflow, graph: {} }).success).toBe(false);
    expect(
      nodeTypeManifestSchema.safeParse({
        ...action,
        metadata: { ...action.metadata, catalog: { exposure: 'public', category: 'data' } },
      }).success,
    ).toBe(false);
    expect(
      nodeCatalogEntrySchema.safeParse({ ...entry(), creation: { execute: 'code' } }).success,
    ).toBe(false);
    expect(nodeCatalogEntrySchema.safeParse({ ...entry(), exposure: 'unknown' }).success).toBe(
      false,
    );
  });

  it('Entry 控制普通 / advanced surface，不改变 target 的能力身份', () => {
    for (const exposure of ['public', 'advanced', 'internal'] as const) {
      const value = { ...entry(), exposure };
      expect(isNodeCatalogEntryVisible(value)).toBe(exposure === 'public');
      expect(isNodeCatalogEntryVisible(value, 'advanced')).toBe(exposure !== 'internal');
      expect(instantiateNodeCatalogEntry(value, action, instance).type).toBe(action.type);
    }
  });
});
