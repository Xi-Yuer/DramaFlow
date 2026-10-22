import { describe, expect, it } from 'vitest';
import {
  workflowDefinitionSchema,
  workflowEdgeSchema,
  type ControlEdgeDefinition,
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

function controlEdge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
): ControlEdgeDefinition {
  return {
    id,
    kind: 'control',
    source: { nodeId: sourceNodeId },
    target: { nodeId: targetNodeId },
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
  it('保留静态绑定、数据边及完整输入输出，不解析资产或运行值', () => {
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

  it('A.output → B.input 与 A → C 只序列化为两条独立关系', () => {
    const source: WorkflowDefinition = {
      inputs: [],
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('a-output-b-input', 'a', 'b', 'input', 'output'), controlEdge('a-c', 'a', 'c')],
      outputs: [],
    };
    const parsed = workflowDefinitionSchema.parse(JSON.parse(JSON.stringify(source)));
    expect(parsed.edges).toEqual(source.edges);
    expect(parsed.edges).toHaveLength(2);
    expect(parsed.nodes.every((entry) => Object.keys(entry.inputs).length === 0)).toBe(true);
    expect(parsed.edges.filter((entry) => entry.kind === 'control')).toHaveLength(1);
  });

  it('相同端点的数据边与控制边可独立共存，不自动补边', () => {
    const source = definition();
    const control: ControlEdgeDefinition = {
      ...controlEdge('control-1', 'a', 'b'),
      source: { nodeId: 'a', portKey: 'text' },
      target: { nodeId: 'b', portKey: 'text' },
    };
    for (const edges of [
      [...source.edges, control],
      [control, ...source.edges],
    ]) {
      expect(workflowDefinitionSchema.parse({ ...source, edges }).edges).toEqual(edges);
    }
    expect(workflowDefinitionSchema.parse(source).edges).toEqual(source.edges);
  });

  it('相同节点间多个目标端口合并依赖检查，不误判合法 DAG', () => {
    const source = definition();
    source.edges = [edge('first', 'a', 'b', 'first'), edge('second', 'a', 'b', 'second')];
    expect(workflowDefinitionSchema.parse(source).edges).toHaveLength(2);
  });

  it('拒绝任意边重复 ID，包括跨种类重复 ID', () => {
    const source = definition();
    for (const edges of [
      [edge('same', 'a', 'b', 'first'), edge('same', 'a', 'b', 'second')],
      [controlEdge('same', 'a', 'b'), controlEdge('same', 'a', 'b')],
      [edge('same', 'a', 'b'), controlEdge('same', 'a', 'b')],
    ])
      expect(workflowDefinitionSchema.safeParse({ ...source, edges }).success).toBe(false);
  });

  it('拒绝数据边或控制边引用不存在的来源或目标节点', () => {
    const source = definition();
    for (const edges of [
      [edge('unknown-source', 'missing', 'b')],
      [edge('unknown-target', 'a', 'missing')],
      [controlEdge('unknown-source', 'missing', 'b')],
      [controlEdge('unknown-target', 'a', 'missing')],
    ])
      expect(workflowDefinitionSchema.safeParse({ ...source, edges }).success).toBe(false);
  });

  it('拒绝旧 connection 绑定、旧控制边字段与未定义的边种类', () => {
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

  it('模板引用多个上游和 workflow input，并保持可往返', () => {
    const prompt = {
      type: 'template' as const,
      value: '请根据 {{outline}} 和 {{characters}} 生成内容，风格：{{style}}',
      variables: {
        outline: { type: 'node_output' as const, nodeId: 'outline', portKey: 'text' },
        characters: { type: 'node_output' as const, nodeId: 'characters', portKey: 'text' },
        style: { type: 'workflow_input' as const, key: 'novel' },
      },
    };
    const source: WorkflowDefinition = {
      inputs: [{ name: 'novel', type: { kind: 'primitive', name: 'string' } }],
      nodes: [node('outline'), node('characters'), node('script', { prompt })],
      edges: [],
      outputs: [],
    };
    expect(workflowDefinitionSchema.parse(JSON.parse(JSON.stringify(source)))).toEqual(source);
  });

  it('模板引用缺失节点、缺失工作流输入或自身时失败', () => {
    const source = (nodeId: string, sourceType: 'node_output' | 'workflow_input') => ({
      inputs: [] as WorkflowDefinition['inputs'],
      nodes: [
        node('script', {
          prompt: {
            type: 'template' as const,
            value: '{{outline}}',
            variables:
              sourceType === 'node_output'
                ? { outline: { type: 'node_output' as const, nodeId, portKey: 'text' } }
                : { outline: { type: 'workflow_input' as const, key: 'missing' } },
          },
        }),
      ],
      edges: [],
      outputs: [],
    });
    expect(
      workflowDefinitionSchema.safeParse(source('missing', 'node_output')).error?.issues,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: '模板变量引用了不存在的节点' })]),
    );
    expect(
      workflowDefinitionSchema.safeParse(source('script', 'workflow_input')).error?.issues,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: '模板变量引用了不存在的工作流输入' }),
      ]),
    );
    expect(
      workflowDefinitionSchema.safeParse(source('script', 'node_output')).error?.issues,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: '模板变量不能引用自身' }),
        expect.objectContaining({ message: '控制关系与数据依赖联合必须无环' }),
      ]),
    );
  });

  it('仅由模板引用形成的环会被发现', () => {
    const reference = (nodeId: string) => ({
      type: 'template' as const,
      value: '{{upstream}}',
      variables: { upstream: { type: 'node_output' as const, nodeId, portKey: 'text' } },
    });
    expect(() =>
      workflowDefinitionSchema.parse({
        inputs: [],
        nodes: [node('a', { prompt: reference('b') }), node('b', { prompt: reference('a') })],
        edges: [],
        outputs: [],
      }),
    ).toThrow('控制关系与数据依赖联合必须无环');
  });

  it('拒绝数据或控制自连、纯数据环、纯控制环与混合环', () => {
    const source = definition();
    for (const self of [edge('self', 'a', 'a'), controlEdge('self', 'a', 'a')])
      expect(workflowDefinitionSchema.safeParse({ ...source, edges: [self] }).success).toBe(false);
    for (const edges of [
      [edge('forward', 'a', 'b'), edge('back', 'b', 'a')],
      [controlEdge('forward', 'a', 'b'), controlEdge('back', 'b', 'a')],
      [edge('forward', 'a', 'b'), controlEdge('back', 'b', 'a')],
      [controlEdge('forward', 'a', 'b'), edge('back', 'b', 'a')],
    ])
      expect(() => workflowDefinitionSchema.parse({ ...source, edges })).toThrow(
        '控制关系与数据依赖联合必须无环',
      );
  });

  it('每个目标输入最多接收一条边，不隐式聚合数组', () => {
    const source = definition();
    source.nodes.push(node('c'));
    const result = workflowDefinitionSchema.safeParse({
      ...source,
      edges: [edge('first', 'a', 'b', 'videos'), edge('second', 'c', 'b', 'videos')],
    });
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ['edges', 1, 'target', 'portKey'],
        params: { code: 'INPUT_SOURCE_CONFLICT' },
      }),
    );
  });

  it('数据边目标与任意静态绑定互斥，包括空值与数组常量', () => {
    const source = definition();
    const bindings: NodeDefinition['inputs'][string][] = [
      { type: 'constant', value: null },
      { type: 'constant', value: [] },
      { type: 'workflow_input', key: 'novel' },
      { type: 'asset', assetId: 'asset', versionId: 'v1' },
      {
        type: 'template',
        value: '{{novel}}',
        variables: { novel: { type: 'workflow_input', key: 'novel' } },
      },
    ];
    for (const binding of bindings) {
      const result = workflowDefinitionSchema.safeParse({
        ...source,
        nodes: [node('a'), node('b', { text: binding })],
      });
      expect(result.error?.issues).toContainEqual(
        expect.objectContaining({
          path: ['edges', 0, 'target', 'portKey'],
          params: { code: 'INPUT_SOURCE_CONFLICT' },
        }),
      );
    }
  });

  it('控制边不占用静态输入或数据端口，多个上游控制关系可以共同到达目标', () => {
    const source = definition();
    source.nodes = [
      node('a'),
      node('b', { text: { type: 'constant', value: '静态输入' } }),
      node('c'),
    ];
    source.edges = [
      {
        ...controlEdge('first-control', 'a', 'b'),
        target: { nodeId: 'b', portKey: 'text' },
      },
      {
        ...controlEdge('second-control', 'c', 'b'),
        target: { nodeId: 'b', portKey: 'text' },
      },
      edge('data-other-port', 'a', 'b', 'other'),
    ];
    expect(workflowDefinitionSchema.parse(source)).toEqual(source);
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
