import { describe, expect, it } from 'vitest';
import {
  connectWorkflowNodes,
  disconnectWorkflowEdge,
  fromReactFlowNode,
  toReactFlowControlEdge,
  toReactFlowEdges,
  toReactFlowNode,
  toReactFlowNodes,
} from '../src/features/workflow/react-flow-adapter';
import { nodeDefinitionSchema, type WorkflowDefinition } from '@dramaflow/contracts';

// 所有节点均为协议测试样例，不注册到生产目录或画布。
function definition() {
  return nodeDefinitionSchema.parse({
    id: 'storyboard',
    type: 'ai.llm',
    typeVersion: 1,
    name: '生成分镜',
    preset: 'storyboard-generator',
    inputs: {
      script: { type: 'connection', nodeId: 'script', outputKey: 'text' },
      style: { type: 'constant', value: '黑白' },
      novel: { type: 'workflow_input', key: 'novel' },
      reference: { type: 'asset', assetId: 'image-v1' },
    },
    config: { prompt: '生成分镜', reference: { colors: ['黑白'] } },
    ui: { position: { x: 120, y: -40 } },
  });
}

function workflow(): WorkflowDefinition {
  return {
    inputs: [{ name: 'novel', type: { kind: 'string' } }],
    nodes: [
      nodeDefinitionSchema.parse({
        id: 'script',
        type: 'ai.llm',
        typeVersion: 1,
        name: '生成剧本',
        inputs: {},
        config: {},
        ui: { position: { x: 0, y: 0 } },
      }),
      definition(),
    ],
    edges: [
      { id: 'route', sourceNodeId: 'script', sourcePort: 'approved', targetNodeId: 'storyboard' },
    ],
    outputs: [],
  };
}

const connection = {
  source: 'script',
  sourceHandle: 'text',
  target: 'storyboard',
  targetHandle: 'style',
};

describe('React Flow 节点协议适配', () => {
  it('区分渲染器与运行类型，往返保留四种绑定、Preset、配置和坐标', () => {
    const input = definition();
    const node = toReactFlowNode(input);
    expect(node.type).toBe('workflowNode');
    expect(node.data.nodeType).toBe('ai.llm');
    expect(node.position).toEqual({ x: 120, y: -40 });
    expect(fromReactFlowNode(node)).toEqual(input);
    expect(toReactFlowNodes(workflow())).toHaveLength(2);
  });

  it('坐标必须来自明确的领域 UI 信息，不再静默提供零坐标', () => {
    const input: Record<string, unknown> = definition();
    delete input.ui;
    expect(() => toReactFlowNode(input)).toThrow();
  });

  it('只导出领域白名单，剔除 React Flow 临时状态和显示数据', () => {
    const input = definition();
    const node = toReactFlowNode(input);
    const exported = fromReactFlowNode({
      ...node,
      selected: true,
      dragging: true,
      measured: { width: 320, height: 200 },
      style: { color: 'cyan' },
      data: { ...node.data, selectedTab: 'preview' },
    });
    expect(exported).toEqual(input);
    expect(exported).not.toHaveProperty('selected');
    expect(exported).not.toHaveProperty('measured');
  });

  it('拒绝未知或缺失的渲染器，不把运行类型误当成渲染器', () => {
    const node = toReactFlowNode(definition());
    expect(() => fromReactFlowNode({ ...node, type: 'llm' })).toThrow('节点渲染器');
    expect(() => fromReactFlowNode({ ...node, type: undefined })).toThrow('节点渲染器');
  });

  it('转换隔离嵌套配置与绑定，视图编辑不改变领域快照', () => {
    const input = definition();
    const node = toReactFlowNode(input);
    input.inputs.script = { type: 'connection', nodeId: 'other-script', outputKey: 'text' };
    input.config.reference = { colors: ['青色'] };
    input.ui.position.x = 900;
    expect(node.data.inputs.script).toEqual({
      type: 'connection',
      nodeId: 'script',
      outputKey: 'text',
    });
    expect(node.data.config.reference).toEqual({ colors: ['黑白'] });
    const exported = fromReactFlowNode(node);
    node.data.inputs.script = { type: 'constant', value: '另一剧本' };
    node.data.config.prompt = '另一提示词';
    node.position.y = 500;
    expect(exported.inputs.script).toEqual({
      type: 'connection',
      nodeId: 'script',
      outputKey: 'text',
    });
    expect(exported.config.prompt).toBe('生成分镜');
    expect(exported.ui.position.y).toBe(-40);
  });

  it.each([NaN, Infinity, -Infinity])('导入与导出均拒绝非有限坐标 %s', (x) => {
    expect(() => toReactFlowNode({ ...definition(), ui: { position: { x, y: 0 } } })).toThrow();
    expect(() =>
      fromReactFlowNode({ ...toReactFlowNode(definition()), position: { x: 0, y: x } }),
    ).toThrow();
  });

  it('导出前校验绑定与 JSON 配置', () => {
    const node = toReactFlowNode(definition());
    expect(() =>
      fromReactFlowNode({
        ...node,
        data: {
          ...node.data,
          inputs: {
            script: { type: 'connection', nodeId: 'script' },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      fromReactFlowNode({ ...node, data: { ...node.data, config: { invoke: () => 'text' } } }),
    ).toThrow();
  });
});

describe('React Flow 连线仅由绑定与控制边派生', () => {
  it('只为 connection 派生数据边，控制边保持独立语义', () => {
    const edges = toReactFlowEdges(workflow());
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({
      source: 'script',
      sourceHandle: 'text',
      target: 'storyboard',
      targetHandle: 'script',
      data: { kind: 'data' },
    });
    expect(edges[1]).toMatchObject({
      source: 'script',
      sourceHandle: 'approved',
      target: 'storyboard',
      data: { kind: 'control' },
    });
    expect(edges[1].targetHandle).toBeUndefined();
  });

  it('控制边和数据边使用不同 ID 命名空间，恶意相同原始 ID 也不冲突', () => {
    const input = workflow();
    input.edges[0].id = toReactFlowEdges(input)[0].id;
    const edges = toReactFlowEdges(input);
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(edges.length);
    expect(toReactFlowControlEdge(input.edges[0])).toEqual(edges[1]);
  });

  it('显式连线仅替换目标端口，不存第二份数据边，不修改原对象', () => {
    const input = workflow();
    const result = connectWorkflowNodes(input, connection);
    expect(result.nodes[1].inputs.style).toEqual({
      type: 'connection',
      nodeId: 'script',
      outputKey: 'text',
    });
    expect(result.nodes[1].inputs.script).toEqual(input.nodes[1].inputs.script);
    expect(input.nodes[1].inputs.style).toEqual({ type: 'constant', value: '黑白' });
    expect(result.edges).toEqual(input.edges);
    expect(toReactFlowEdges(result).filter((edge) => edge.data?.kind === 'data')).toHaveLength(2);
    expect(connectWorkflowNodes(result, connection)).toEqual(result);
  });

  it.each([undefined, null, '', 'bad-handle'])('连接拒绝缺失或非法端口 %s', (handle) => {
    expect(() =>
      connectWorkflowNodes(workflow(), { ...connection, sourceHandle: handle }),
    ).toThrow();
    expect(() =>
      connectWorkflowNodes(workflow(), { ...connection, targetHandle: handle }),
    ).toThrow();
  });

  it('连接拒绝不存在的端点', () => {
    expect(() => connectWorkflowNodes(workflow(), { ...connection, source: 'missing' })).toThrow(
      '来源节点',
    );
    expect(() => connectWorkflowNodes(workflow(), { ...connection, target: 'missing' })).toThrow(
      '目标节点',
    );
  });

  it('断开数据边只删除对应绑定，保留其余输入和控制边', () => {
    const input = connectWorkflowNodes(workflow(), connection);
    const edge = toReactFlowEdges(input).find((item) => item.targetHandle === 'style');
    const result = disconnectWorkflowEdge(input, edge);
    expect(result.nodes[1].inputs).not.toHaveProperty('style');
    expect(result.nodes[1].inputs.script).toEqual(input.nodes[1].inputs.script);
    expect(result.edges).toEqual(input.edges);
    expect(input.nodes[1].inputs.style).toHaveProperty('type', 'connection');
  });

  it('过期断开事件不能删除已重新绑定的值，伪造 ID 不能误删其他输入', () => {
    const input = workflow();
    const edge = toReactFlowEdges(input)[0];
    input.nodes[1].inputs.script = { type: 'constant', value: '用户输入' };
    expect(disconnectWorkflowEdge(input, edge)).toEqual(input);
    const updated = connectWorkflowNodes(input, {
      ...connection,
      targetHandle: 'script',
      sourceHandle: 'newText',
    });
    expect(disconnectWorkflowEdge(updated, edge)).toEqual(updated);
    const valid = toReactFlowEdges(updated)[0];
    expect(disconnectWorkflowEdge(updated, { ...valid, id: 'wrong-id' })).toEqual(updated);
  });

  it('删除控制边只删除匹配路由，保留相同端点的数据关系', () => {
    const input = workflow();
    const edge = toReactFlowEdges(input).find((item) => item.data?.kind === 'control');
    const result = disconnectWorkflowEdge(input, edge);
    expect(result.edges).toEqual([]);
    expect(result.nodes[1].inputs).toEqual(input.nodes[1].inputs);
    expect(disconnectWorkflowEdge(input, { ...edge, sourceHandle: 'otherBranch' })).toEqual(input);
  });
});
