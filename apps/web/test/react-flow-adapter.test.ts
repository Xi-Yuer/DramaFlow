import { describe, expect, it } from 'vitest';
import {
  fromReactFlowEdge,
  fromReactFlowNode,
  toReactFlowEdge,
  toReactFlowNode,
} from '../src/features/workflow/react-flow-adapter';

// 仅验证编辑视图与平台协议的适配，不注册生产节点或接入画布保存接口。
function definition() {
  return {
    id: 'storyboard',
    type: 'llm',
    name: '生成分镜',
    preset: 'storyboard-generator',
    inputs: [{ target: 'script', source: { nodeId: 'script', outputKey: 'text' } }],
    config: { prompt: '生成分镜', reference: { colors: ['黑白'] } },
    ui: { position: { x: 120, y: -40 } },
  };
}

const edgeDefinition = {
  id: 'script-to-storyboard',
  sourceNodeId: 'script',
  sourceHandle: 'text',
  targetNodeId: 'storyboard',
  targetHandle: 'script',
};

describe('React Flow 节点协议适配', () => {
  it('区分渲染器与运行类型，往返保留绑定、Preset、配置和坐标', () => {
    const input = definition();
    const node = toReactFlowNode(input);

    expect(node.type).toBe('workflowNode');
    expect(node.data.nodeType).toBe('llm');
    expect(node.position).toEqual({ x: 120, y: -40 });
    expect(fromReactFlowNode(node)).toEqual(input);
  });

  it('没有 ui 时仅为编辑视图提供零坐标，显式导出再保存当前坐标', () => {
    const original = definition();
    const input = {
      id: original.id,
      type: original.type,
      name: original.name,
      inputs: original.inputs,
      config: original.config,
    };
    const node = toReactFlowNode(input);

    expect(node.position).toEqual({ x: 0, y: 0 });
    expect(input).not.toHaveProperty('ui');
    expect(node.data).not.toHaveProperty('preset');
    node.position = { x: 80, y: 160 };
    expect(fromReactFlowNode(node)).toEqual({ ...input, ui: { position: node.position } });
  });

  it('只导出白名单字段，剔除 React Flow 临时状态和显示数据', () => {
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

  it('双向转换都隔离嵌套数据，后续编辑不修改另一侧对象', () => {
    const input = definition();
    const node = toReactFlowNode(input);
    input.inputs[0].source.nodeId = 'other-script';
    input.config.reference.colors.push('青色');
    input.ui.position.x = 900;

    expect(node.data.inputs[0].source.nodeId).toBe('script');
    expect(node.data.config.reference).toEqual({ colors: ['黑白'] });
    expect(node.position.x).toBe(120);

    const exported = fromReactFlowNode(node);
    node.data.inputs[0].source.outputKey = 'changed';
    node.data.config.prompt = '另一提示词';
    node.position.y = 500;

    expect(exported.inputs[0].source.outputKey).toBe('text');
    expect(exported.config.prompt).toBe('生成分镜');
    expect(exported.ui?.position.y).toBe(-40);
  });

  it.each([NaN, Infinity, -Infinity])('导入与导出均拒绝非有限坐标 %s', (x) => {
    expect(() => toReactFlowNode({ ...definition(), ui: { position: { x, y: 0 } } })).toThrow();
    expect(() =>
      fromReactFlowNode({ ...toReactFlowNode(definition()), position: { x: 0, y: x } }),
    ).toThrow();
  });

  it('导出前仍校验领域协议，不接受重复输入绑定或不可序列化配置', () => {
    const node = toReactFlowNode(definition());
    expect(() =>
      fromReactFlowNode({
        ...node,
        data: { ...node.data, inputs: [...node.data.inputs, ...node.data.inputs] },
      }),
    ).toThrow('重复绑定');
    expect(() =>
      fromReactFlowNode({ ...node, data: { ...node.data, config: { invoke: () => 'text' } } }),
    ).toThrow();
  });
});

describe('React Flow 连线协议适配', () => {
  it('完整保留双端节点和端口映射，忽略显示状态', () => {
    const edge = toReactFlowEdge(edgeDefinition);
    expect(edge).toEqual({
      id: edgeDefinition.id,
      source: 'script',
      sourceHandle: 'text',
      target: 'storyboard',
      targetHandle: 'script',
    });
    expect(fromReactFlowEdge({ ...edge, selected: true, animated: true })).toEqual(edgeDefinition);
  });

  it.each([undefined, null, '', 'bad-handle'])('拒绝缺失或非法端口 %s', (handle) => {
    const edge = toReactFlowEdge(edgeDefinition);
    expect(() => fromReactFlowEdge({ ...edge, sourceHandle: handle })).toThrow();
    expect(() => fromReactFlowEdge({ ...edge, targetHandle: handle })).toThrow();
  });
});
