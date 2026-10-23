import { describe, expect, it } from 'vitest';
import { nodeTypeManifestSchema } from '../src/index.js';

const action = {
  type: 'test.action',
  version: 1,
  executionKind: 'action',
  metadata: { name: '测试', category: 'data' },
  inputs: [],
  outputs: [],
  config: [],
};
const control = {
  ...action,
  type: 'flow.if',
  executionKind: 'control',
  controlOutputs: [
    { key: 'true', name: '条件成立' },
    { key: 'false', name: '条件不成立', description: '未满足比较条件' },
  ],
};
describe('Manifest 控制出口声明', () => {
  it('可声明独立控制出口，不携带数据类型，也不混入数据 outputs', () => {
    const result = nodeTypeManifestSchema.parse(control);
    expect(result.controlOutputs).toEqual(control.controlOutputs);
    expect(result.outputs).toEqual([]);
  });
  it('未声明 controlOutputs 的 Action 原样保留，不注入字段', () => {
    expect(nodeTypeManifestSchema.parse(action)).toEqual(action);
  });
  it.each(
    [
      [
        { key: 'true', name: '成立' },
        { key: 'true', name: '重复' },
      ],
      [{ key: 'not valid', name: '无效' }],
      [{ key: 'constructor', name: '保留名' }],
      [{ key: 'true', name: '' }],
      [{ key: 'true', name: '成立', dataType: { kind: 'primitive', name: 'boolean' } }],
    ].map((controlOutputs) => ({ controlOutputs })),
  )('拒绝重复或不合法控制出口 $controlOutputs', ({ controlOutputs }) => {
    expect(nodeTypeManifestSchema.safeParse({ ...control, controlOutputs }).success).toBe(false);
  });
});
