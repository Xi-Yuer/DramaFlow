import { describe, expect, it } from 'vitest';
import {
  workflowDefinitionSchema,
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

function definition(): WorkflowDefinition {
  return {
    inputs: [{ name: 'novel', type: { kind: 'string' } }],
    nodes: [
      node('a', { novel: { type: 'workflow_input', key: 'novel' } }),
      node('b', {
        text: { type: 'connection', nodeId: 'a', outputKey: 'text' },
        reference: { type: 'asset', assetId: 'not-loaded' },
        count: { type: 'constant', value: 0 },
      }),
    ],
    edges: [{ id: 'control-1', sourceNodeId: 'a', targetNodeId: 'b' }],
    outputs: [
      { name: 'text', type: { kind: 'string' }, source: { nodeId: 'b', outputKey: 'text' } },
    ],
  };
}

describe('正式 WorkflowDefinition 静态校验', () => {
  it('保留四种绑定、独立控制关系及完整输入输出，不解析资产或运行值', () => {
    const source = definition();
    expect(workflowDefinitionSchema.parse(JSON.parse(JSON.stringify(source)))).toEqual(source);
    expect(
      workflowDefinitionSchema.parse({ inputs: [], nodes: [], edges: [], outputs: [] }).nodes,
    ).toEqual([]);
  });

  it('相同节点间多个数据与控制依赖合并检查，不误判合法 DAG', () => {
    const source = definition();
    source.nodes = [
      node('a'),
      node('b', {
        first: { type: 'connection', nodeId: 'a', outputKey: 'text' },
        second: { type: 'connection', nodeId: 'a', outputKey: 'other' },
      }),
    ];
    source.edges.push({ id: 'control-2', sourceNodeId: 'a', targetNodeId: 'b' });
    expect(workflowDefinitionSchema.parse(source).nodes).toHaveLength(2);
  });

  it('拒绝控制边重复 ID 和不存在的来源或目标节点', () => {
    const source = definition();
    for (const edges of [
      [
        { id: 'same', sourceNodeId: 'a', targetNodeId: 'b' },
        { id: 'same', sourceNodeId: 'a', targetNodeId: 'b' },
      ],
      [{ id: 'unknown-source', sourceNodeId: 'missing', targetNodeId: 'b' }],
      [{ id: 'unknown-target', sourceNodeId: 'a', targetNodeId: 'missing' }],
    ])
      expect(workflowDefinitionSchema.safeParse({ ...source, edges }).success).toBe(false);
  });

  it('拒绝未知 connection 节点和 workflow_input 名称', () => {
    const invalidInputs: NodeDefinition['inputs'][] = [
      { text: { type: 'connection', nodeId: 'missing', outputKey: 'text' } },
      { novel: { type: 'workflow_input', key: 'missing' } },
    ];
    for (const inputs of invalidInputs) {
      expect(
        workflowDefinitionSchema.safeParse({
          ...definition(),
          nodes: [node('a'), node('b', inputs)],
        }).success,
      ).toBe(false);
    }
  });

  it('拒绝数据自引用与控制自连', () => {
    const source = definition();
    expect(
      workflowDefinitionSchema.safeParse({
        ...source,
        nodes: [
          node('a'),
          node('b', { text: { type: 'connection', nodeId: 'b', outputKey: 'text' } }),
        ],
      }).success,
    ).toBe(false);
    expect(
      workflowDefinitionSchema.safeParse({
        ...source,
        edges: [{ id: 'self', sourceNodeId: 'a', targetNodeId: 'a' }],
      }).success,
    ).toBe(false);
  });

  it('拒绝纯控制环、纯数据环及联合依赖环', () => {
    const source = definition();
    const controlCycle = {
      ...source,
      nodes: [node('a'), node('b')],
      edges: [
        { id: 'forward', sourceNodeId: 'a', targetNodeId: 'b' },
        { id: 'back', sourceNodeId: 'b', targetNodeId: 'a' },
      ],
    };
    const dataCycle = {
      ...source,
      edges: [],
      nodes: [
        node('a', { value: { type: 'connection', nodeId: 'b', outputKey: 'text' } }),
        node('b', { value: { type: 'connection', nodeId: 'a', outputKey: 'text' } }),
      ],
    };
    const combinedCycle = {
      ...source,
      edges: [{ id: 'back', sourceNodeId: 'b', targetNodeId: 'a' }],
    };
    for (const value of [controlCycle, dataCycle, combinedCycle]) {
      expect(() => workflowDefinitionSchema.parse(value)).toThrow('联合必须无环');
    }
  });

  it('没有 manifest 时仅验证输出键语法，不猜端口是否存在', () => {
    const source = definition();
    source.nodes = [
      node('a'),
      node('b', { input: { type: 'connection', nodeId: 'a', outputKey: 'notDeclared' } }),
    ];
    source.edges = [{ id: 'route', sourceNodeId: 'a', targetNodeId: 'b' }];
    source.outputs = [
      {
        name: 'text',
        type: { kind: 'string' },
        source: { nodeId: 'b', outputKey: 'unknownResult' },
      },
    ];
    expect(workflowDefinitionSchema.parse(source)).toEqual(source);
    expect(
      workflowDefinitionSchema.safeParse({
        ...source,
        edges: [{ id: 'route', sourceNodeId: 'a', sourcePort: 'unknownRoute', targetNodeId: 'b' }],
      }).success,
    ).toBe(false);
  });

  it('工作流输出引用和顶层唯一性继续使用已有 factory 校验', () => {
    const source = definition();
    for (const extra of [
      { nodes: [node('a'), node('a'), node('b')] },
      {
        inputs: [
          { name: 'novel', type: { kind: 'string' } },
          { name: 'novel', type: { kind: 'string' } },
        ],
      },
      {
        outputs: [
          {
            name: 'text',
            type: { kind: 'string' },
            source: { nodeId: 'missing', outputKey: 'text' },
          },
        ],
      },
    ])
      expect(workflowDefinitionSchema.safeParse({ ...source, ...extra }).success).toBe(false);
  });
});
