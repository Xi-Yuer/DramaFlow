import { describe, expect, it } from 'vitest';
import { nodeTypeManifestSchema } from '@dramaflow/contracts';
import { createTestWorkflowNode as createWorkflowNode } from './fixtures/node-catalog';

const manifest = nodeTypeManifestSchema.parse({
  type: 'data.transform',
  version: 7,
  executionKind: 'action',
  metadata: { name: '数据转换', category: 'data', description: '转换输入数据' },
  inputs: [{ key: 'source', name: '数据', dataType: { kind: 'any' }, required: true }],
  outputs: [],
  config: [
    { key: 'label', name: '标签', type: 'string', defaultValue: '' },
    { key: 'count', name: '次数', type: 'number', defaultValue: 0 },
    { key: 'enabled', name: '启用', type: 'boolean', defaultValue: false },
    {
      key: 'mode',
      name: '模式',
      type: 'select',
      options: [{ label: '复制', value: 'copy' }],
      defaultValue: 'copy',
    },
    { key: 'destination', name: '目标', type: 'string', required: true },
  ],
});

describe('通用节点创建', () => {
  it('精确保留类型版本、外部实例身份、名称和画布坐标，不初始化绑定或 preset', () => {
    const node = createWorkflowNode(manifest, 'node_first', '转换第一段', { x: -12.5, y: 42 });
    expect(node).toEqual({
      id: 'node_first',
      type: 'data.transform',
      typeVersion: 7,
      name: '转换第一段',
      inputs: {},
      config: { label: '', count: 0, enabled: false, mode: 'copy' },
      ui: { position: { x: -12.5, y: 42 } },
    });
  });

  it('缺少默认值的字段不会生成配置，也不会填补必填字段', () => {
    const node = createWorkflowNode(
      { ...manifest, config: [manifest.config[4]!] },
      'node_second',
      manifest.metadata.name,
      { x: 0, y: 0 },
    );
    expect(node.config).toEqual({});
    expect(node.inputs).toEqual({});
    expect(
      createWorkflowNode({ ...manifest, config: [] }, 'node_empty', '无配置', { x: 0, y: 0 })
        .config,
    ).toEqual({});
  });

  it('每次创建独立实例，不修改 Manifest 或调用方 position', () => {
    const original = structuredClone(manifest);
    const position = { x: 3, y: 4 };
    const a = createWorkflowNode(manifest, 'node_a', '甲', position);
    const b = createWorkflowNode({ ...manifest, version: 8 }, 'node_b', '乙', position);
    a.config.count = 9;
    a.ui.position.x = 99;
    expect(b.typeVersion).toBe(8);
    expect(b.config.count).toBe(0);
    expect(position).toEqual({ x: 3, y: 4 });
    expect(manifest).toEqual(original);
  });
});
