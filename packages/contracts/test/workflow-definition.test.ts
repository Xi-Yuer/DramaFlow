import { describe, expect, it } from 'vitest';
import {
  workflowDefinitionSchema,
  workflowEdgeSchema,
  type DataEdgeDefinition,
  type NodeDefinition,
  type WorkflowDefinition,
} from '../src/index.js';

function node(id: string, inputs: NodeDefinition['inputs'] = {}): NodeDefinition {
  return {
    id,
    type: 'data.test',
    typeVersion: 1,
    name: id,
    inputs,
    config: {},
    ui: { position: { x: 0, y: 0 } },
  };
}

function edge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  targetPortKey = 'text',
  sourcePortKey = 'text',
): DataEdgeDefinition {
  return {
    id,
    kind: 'data',
    source: { nodeId: sourceNodeId, portKey: sourcePortKey },
    target: { nodeId: targetNodeId, portKey: targetPortKey },
  };
}

function definition(): WorkflowDefinition {
  return {
    inputs: [{ name: 'novel', type: { kind: 'primitive', name: 'string' } }],
    nodes: [
      node('a', { novel: { type: 'workflow_input', key: 'novel' } }),
      node('b', {
        reference: { type: 'asset', assetId: 'not-loaded', versionId: 'asset-version-1' },
        count: { type: 'constant', value: 0 },
      }),
    ],
    edges: [edge('data-1', 'a', 'b')],
    outputs: [
      {
        name: 'text',
        type: { kind: 'primitive', name: 'string' },
        source: { nodeId: 'b', outputKey: 'text' },
      },
    ],
  };
}

describe('正式 WorkflowDefinition 静态校验', () => {
  it('保留三种静态绑定、数据边及完整输入输出，不解析资产或运行值', () => {
    const source = definition();
    expect(workflowDefinitionSchema.parse(JSON.parse(JSON.stringify(source)))).toEqual(source);
    expect(
      workflowDefinitionSchema.parse({ inputs: [], nodes: [], edges: [], outputs: [] }).nodes,
    ).toEqual([]);
  });

  it('图片生成到图生视频的连接只在 edges 保存一次', () => {
    const source = {
      inputs: [],
      nodes: [node('image-generator'), node('image-to-video')],
      edges: [edge('image-edge', 'image-generator', 'image-to-video', 'image', 'image')],
      outputs: [],
    };
    const serialized = JSON.stringify(workflowDefinitionSchema.parse(source));
    const parsed = workflowDefinitionSchema.parse(JSON.parse(serialized));
    expect(parsed.edges).toEqual(source.edges);
    expect(parsed.nodes[1]?.inputs).not.toHaveProperty('image');
    expect(parsed.nodes.every((entry) => Object.keys(entry.inputs).length === 0)).toBe(true);
  });

  it('相同节点间多个目标端口合并依赖检查，不误判合法 DAG', () => {
    const source = definition();
    source.edges = [edge('first', 'a', 'b', 'first'), edge('second', 'a', 'b', 'second')];
    expect(workflowDefinitionSchema.parse(source).edges).toHaveLength(2);
  });

  it('拒绝数据边重复 ID 和不存在的来源或目标节点', () => {
    const source = definition();
    for (const edges of [
      [edge('same', 'a', 'b', 'first'), edge('same', 'a', 'b', 'second')],
      [edge('unknown-source', 'missing', 'b')],
      [edge('unknown-target', 'a', 'missing')],
    ])
      expect(workflowDefinitionSchema.safeParse({ ...source, edges }).success).toBe(false);
  });

  it('拒绝旧 connection 绑定、控制边与未定义的边种类', () => {
    const source = definition();
    expect(
      workflowDefinitionSchema.safeParse({
        ...source,
        nodes: [
          node('a'),
          {
            ...node('b'),
            inputs: { text: { type: 'connection', nodeId: 'a', outputKey: 'text' } },
          },
        ],
      }).success,
    ).toBe(false);
    for (const legacyEdge of [
      { id: 'control', sourceNodeId: 'a', targetNodeId: 'b' },
      { ...edge('control', 'a', 'b'), kind: 'control' },
      { ...edge('unknown', 'a', 'b'), kind: 'unknown' },
    ]) {
      expect(workflowEdgeSchema.safeParse(legacyEdge).success).toBe(false);
      expect(workflowDefinitionSchema.safeParse({ ...source, edges: [legacyEdge] }).success).toBe(
        false,
      );
    }
  });

  it('拒绝不存在的 workflow_input 名称', () => {
    expect(
      workflowDefinitionSchema.safeParse({
        ...definition(),
        nodes: [node('a'), node('b', { novel: { type: 'workflow_input', key: 'missing' } })],
      }).success,
    ).toBe(false);
  });

  it('拒绝自连和数据环', () => {
    const source = definition();
    expect(
      workflowDefinitionSchema.safeParse({ ...source, edges: [edge('self', 'a', 'a')] }).success,
    ).toBe(false);
    expect(() =>
      workflowDefinitionSchema.parse({
        ...source,
        edges: [edge('forward', 'a', 'b'), edge('back', 'b', 'a')],
      }),
    ).toThrow('数据依赖必须无环');
  });

  it('每个目标输入最多接收一条边，不隐式聚合数组', () => {
    const source = definition();
    source.nodes.push(node('c'));
    expect(
      workflowDefinitionSchema.safeParse({
        ...source,
        edges: [edge('first', 'a', 'b', 'videos'), edge('second', 'c', 'b', 'videos')],
      }).success,
    ).toBe(false);
  });

  it('数据边目标与任意静态绑定互斥，包括空值与数组常量', () => {
    const source = definition();
    const bindings: NodeDefinition['inputs'][string][] = [
      { type: 'constant', value: null },
      { type: 'constant', value: [] },
      { type: 'workflow_input', key: 'novel' },
      { type: 'asset', assetId: 'asset', versionId: 'v1' },
    ];
    for (const binding of bindings)
      expect(
        workflowDefinitionSchema.safeParse({
          ...source,
          nodes: [node('a'), node('b', { text: binding })],
        }).success,
      ).toBe(false);
  });

  it('同名输入端口可分别属于不同目标节点', () => {
    const source = definition();
    source.nodes.push(node('c'));
    source.edges.push(edge('another-target', 'a', 'c'));
    expect(workflowDefinitionSchema.parse(source).edges).toHaveLength(2);
  });

  it('没有 manifest 时仅验证端口键语法，不猜端口存在或类型', () => {
    const source = definition();
    source.edges = [edge('route', 'a', 'b', 'notDeclaredInput', 'notDeclaredOutput')];
    source.outputs = [
      {
        name: 'text',
        type: { kind: 'primitive', name: 'string' },
        source: { nodeId: 'b', outputKey: 'unknownResult' },
      },
    ];
    expect(workflowDefinitionSchema.parse(source)).toEqual(source);
    expect(
      workflowDefinitionSchema.safeParse({
        ...source,
        edges: [edge('route', 'a', 'b', 'bad.key')],
      }).success,
    ).toBe(false);
  });

  it('工作流输出引用和顶层唯一性继续使用已有 factory 校验', () => {
    const source = definition();
    for (const extra of [
      { nodes: [node('a'), node('a'), node('b')] },
      {
        inputs: [
          { name: 'novel', type: { kind: 'primitive', name: 'string' } },
          { name: 'novel', type: { kind: 'primitive', name: 'string' } },
        ],
      },
      {
        outputs: [
          {
            name: 'text',
            type: { kind: 'primitive', name: 'string' },
            source: { nodeId: 'missing', outputKey: 'text' },
          },
        ],
      },
    ])
      expect(workflowDefinitionSchema.safeParse({ ...source, ...extra }).success).toBe(false);
  });
});
