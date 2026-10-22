import { describe, expect, it } from 'vitest';
import {
  workflowDefinitionSchema,
  type ControlEdgeDefinition,
  type NodeDefinition,
  type NodeTypeManifest,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import {
  connectWorkflowNodes,
  controlEdgeToReactFlowEdge,
  disconnectWorkflowEdge,
  fromReactFlowEdge,
  reconnectWorkflowEdge,
  toReactFlowEdges,
} from '../src/features/workflow/canvas/react-flow-adapter';
import {
  areWorkflowHandlesCompatible,
  controlHandleId,
  parseWorkflowHandle,
} from '../src/features/workflow/canvas/workflow-handles';

const controlConnection = {
  source: 'A',
  sourceHandle: controlHandleId('source'),
  target: 'C',
  targetHandle: controlHandleId('target'),
};
const dataConnection = {
  source: 'A',
  sourceHandle: 'output',
  target: 'B',
  targetHandle: 'input',
};

function node(id: string): NodeDefinition {
  return {
    id,
    type: 'data.test',
    typeVersion: 1,
    name: id,
    inputs: { control: { type: 'constant', value: '保留静态来源' } },
    config: {},
    ui: { position: { x: 0, y: 0 } },
  };
}

function workflow(): WorkflowDefinition {
  return { inputs: [], nodes: [node('A'), node('B'), node('C')], edges: [], outputs: [] };
}

function catalog(): NodeTypeManifest[] {
  return [
    {
      type: 'data.test',
      version: 1,
      executionKind: 'action',
      metadata: { name: '测试操作', category: 'data' },
      inputs: [
        { key: 'input', name: '输入', dataType: { kind: 'primitive', name: 'string' } },
        {
          key: 'control',
          name: '名为 control 的数据输入',
          dataType: { kind: 'primitive', name: 'string' },
        },
      ],
      outputs: [
        { key: 'output', name: '输出', dataType: { kind: 'primitive', name: 'string' } },
        {
          key: 'control',
          name: '名为 control 的数据输出',
          dataType: { kind: 'primitive', name: 'string' },
        },
      ],
      config: [],
    },
  ];
}

function controlEdge(): ControlEdgeDefinition {
  return { id: 'control_1', kind: 'control', source: { nodeId: 'A' }, target: { nodeId: 'C' } };
}

describe('Data / Control Handle 硬边界', () => {
  it.each([
    ['output', 'input', true],
    [controlHandleId('source'), controlHandleId('target'), true],
    ['output', controlHandleId('target'), false],
    [controlHandleId('source'), 'input', false],
    ['control', 'control', true],
    [controlHandleId('target'), controlHandleId('source'), false],
  ])('%s → %s 的拖线兼容性为 %s', (source, target, expected) => {
    expect(areWorkflowHandlesCompatible(source, target)).toBe(expected);
  });

  it('onConnect 使用相同分类拒绝两种混连，失败不改定义', () => {
    const input = workflow();
    const snapshot = structuredClone(input);
    for (const connection of [
      { ...dataConnection, targetHandle: controlHandleId('target') },
      { ...dataConnection, sourceHandle: controlHandleId('source') },
    ])
      expect(() => connectWorkflowNodes(input, connection, catalog())).toThrow('不能混连');
    expect(input).toEqual(snapshot);
  });

  it('数据端口叫 control 仍按 Manifest 类型校验，不成为执行关系', () => {
    const result = connectWorkflowNodes(
      workflow(),
      {
        ...dataConnection,
        sourceHandle: 'control',
        targetHandle: 'control',
      },
      catalog(),
      { replaceBinding: true },
    );
    expect(result.edges).toEqual([
      {
        id: expect.any(String),
        kind: 'data',
        source: { nodeId: 'A', portKey: 'control' },
        target: { nodeId: 'B', portKey: 'control' },
      },
    ]);
  });

  it.each([null, undefined, '', 'control:source:', 'control:source:bad.key'])(
    '拒绝无效来源 Handle %s',
    (source) => {
      expect(areWorkflowHandlesCompatible(source, controlHandleId('target'))).toBe(false);
      expect(() =>
        connectWorkflowNodes(workflow(), { ...controlConnection, sourceHandle: source }, catalog()),
      ).toThrow();
    },
  );
});

describe('Control Edge 无损映射与独立持久语义', () => {
  it('普通控制边使用专用 Handle，往返不把 UI Handle 写成 portKey', () => {
    const definition = controlEdge();
    const edge = controlEdgeToReactFlowEdge(definition);
    expect(edge).toMatchObject({
      id: 'control_1',
      source: 'A',
      sourceHandle: controlHandleId('source'),
      target: 'C',
      targetHandle: controlHandleId('target'),
      data: { kind: 'control' },
    });
    expect(fromReactFlowEdge({ ...edge, selected: true, animated: true })).toEqual(definition);
    expect(fromReactFlowEdge(edge).source).not.toHaveProperty('portKey');
    expect(fromReactFlowEdge(edge).target).not.toHaveProperty('portKey');
    expect(fromReactFlowEdge({ ...edge, sourceHandle: null, targetHandle: undefined })).toEqual(
      definition,
    );
  });

  it.each([
    { source: { nodeId: 'A', portKey: 'approved' }, target: { nodeId: 'C' } },
    { source: { nodeId: 'A' }, target: { nodeId: 'C', portKey: 'entry' } },
    { source: { nodeId: 'A', portKey: 'rejected' }, target: { nodeId: 'C', portKey: 'rewrite' } },
  ])('保留可选控制端口 $source.portKey → $target.portKey', (endpoints) => {
    const input: ControlEdgeDefinition = { ...controlEdge(), ...endpoints };
    const edge = controlEdgeToReactFlowEdge(input);
    expect(fromReactFlowEdge(edge)).toEqual(input);
    expect(parseWorkflowHandle(edge.sourceHandle, 'source')).toEqual({
      kind: 'control',
      ...(input.source.portKey ? { portKey: input.source.portKey } : {}),
    });
  });

  it('验收图只保存 A.output→B.input 和 A→C，不自动补控制边', () => {
    const dataOnly = connectWorkflowNodes(workflow(), dataConnection, catalog());
    expect(dataOnly.edges.map((edge) => edge.kind)).toEqual(['data']);
    const mixed = connectWorkflowNodes(dataOnly, controlConnection, catalog());
    mixed.edges[0].id = 'data_1';
    mixed.edges[1].id = 'control_1';
    const saved = workflowDefinitionSchema.parse(JSON.parse(JSON.stringify(mixed)));
    expect(saved.edges).toEqual([
      {
        id: 'data_1',
        kind: 'data',
        source: { nodeId: 'A', portKey: 'output' },
        target: { nodeId: 'B', portKey: 'input' },
      },
      controlEdge(),
    ]);
    expect(toReactFlowEdges(saved).map(fromReactFlowEdge)).toEqual(saved.edges);
    expect(saved.nodes).toEqual(workflow().nodes);
  });

  it('没有任何数据端口也能显式连接普通控制边，不读取或删除静态输入', () => {
    const input = workflow();
    const manifests = catalog().map((manifest) => ({ ...manifest, inputs: [], outputs: [] }));
    const result = connectWorkflowNodes(input, controlConnection, manifests);
    expect(result.edges[0]).toMatchObject({
      kind: 'control',
      source: { nodeId: 'A' },
      target: { nodeId: 'C' },
    });
    expect(result.nodes).toEqual(input.nodes);
  });

  it('控制边不占用数据端口，允许同节点对的显式 Data 和 Control', () => {
    const withControl = connectWorkflowNodes(
      workflow(),
      { ...controlConnection, target: 'B' },
      catalog(),
    );
    const result = connectWorkflowNodes(withControl, dataConnection, catalog());
    expect(result.edges.map((edge) => edge.kind)).toEqual(['control', 'data']);
    expect(result.nodes[1].inputs.control).toEqual(workflow().nodes[1].inputs.control);
    expect(() => connectWorkflowNodes(result, dataConnection, catalog())).toThrow('已经存在连接');
  });

  it('多个控制上游只保存显式边，不在模型层赋予 Join 策略', () => {
    const first = connectWorkflowNodes(workflow(), controlConnection, catalog());
    const result = connectWorkflowNodes(first, { ...controlConnection, source: 'B' }, catalog());
    expect(result.edges).toHaveLength(2);
    expect(result.edges.map((edge) => edge.source.nodeId)).toEqual(['A', 'B']);
    expect(result.nodes).toEqual(workflow().nodes);
  });

  it('缺失节点、精确 Manifest 或自连接仍拒绝控制连线', () => {
    expect(() =>
      connectWorkflowNodes(workflow(), { ...controlConnection, source: 'missing' }, catalog()),
    ).toThrow('来源节点');
    expect(() =>
      connectWorkflowNodes(workflow(), { ...controlConnection, target: 'missing' }, catalog()),
    ).toThrow('目标节点');
    expect(() =>
      connectWorkflowNodes(workflow(), { ...controlConnection, target: 'A' }, catalog()),
    ).toThrow('不能连接自身');
    expect(() => connectWorkflowNodes(workflow(), controlConnection, [])).toThrow('节点类型不可用');
    const input = workflow();
    input.nodes[2].typeVersion = 2;
    expect(() => connectWorkflowNodes(input, controlConnection, catalog())).toThrow(
      '节点类型不可用',
    );
  });

  it('命名控制端口可往返保存，但不冒充已声明的路由 UI', () => {
    expect(() =>
      connectWorkflowNodes(
        workflow(),
        {
          ...controlConnection,
          sourceHandle: controlHandleId('source', 'approved'),
        },
        catalog(),
      ),
    ).toThrow('命名控制端口尚未声明');
  });

  it('导出时 kind 不能掩盖 data/control Handle 混用', () => {
    const control = controlEdgeToReactFlowEdge(controlEdge());
    expect(() => fromReactFlowEdge({ ...control, sourceHandle: 'output' })).toThrow(
      '控制边只能连接控制端口',
    );
    expect(() => fromReactFlowEdge({ ...control, targetHandle: 'input' })).toThrow(
      '控制边只能连接控制端口',
    );
    expect(() => fromReactFlowEdge({ ...control, data: { kind: 'data' } })).toThrow();
  });
});

describe('两类边的删除与重连', () => {
  it('控制边删除不影响相同节点对的数据边或静态绑定', () => {
    const data = connectWorkflowNodes(workflow(), dataConnection, catalog());
    const input = connectWorkflowNodes(data, { ...controlConnection, target: 'B' }, catalog());
    const edge = toReactFlowEdges(input).find((item) => item.data?.kind === 'control')!;
    expect(disconnectWorkflowEdge(input, edge)).toEqual(data);
  });

  it('控制边重连保持 kind / ID，旧端点快照不能删改新边', () => {
    const input = { ...workflow(), edges: [controlEdge()] };
    const edge = toReactFlowEdges(input)[0];
    const result = reconnectWorkflowEdge(
      input,
      edge,
      { ...controlConnection, target: 'B' },
      catalog(),
    );
    expect(result.edges).toEqual([{ ...controlEdge(), target: { nodeId: 'B' } }]);
    expect(disconnectWorkflowEdge(result, edge)).toEqual(result);
    expect(reconnectWorkflowEdge(result, edge, controlConnection, catalog())).toEqual(result);
    expect(input.edges).toEqual([controlEdge()]);
  });

  it('重连禁止改变边种类，失败保留原始关系', () => {
    const controls = { ...workflow(), edges: [controlEdge()] };
    expect(() =>
      reconnectWorkflowEdge(controls, toReactFlowEdges(controls)[0], dataConnection, catalog()),
    ).toThrow('不能改变边类型');
    const data = connectWorkflowNodes(workflow(), dataConnection, catalog());
    expect(() =>
      reconnectWorkflowEdge(data, toReactFlowEdges(data)[0], controlConnection, catalog()),
    ).toThrow('不能改变边类型');
    expect(controls.edges).toEqual([controlEdge()]);
    expect(data.edges[0].kind).toBe('data');
  });

  it('仅做静态联合验环，失败的重连不移除旧边', () => {
    const data = connectWorkflowNodes(workflow(), dataConnection, catalog());
    const input = connectWorkflowNodes(data, { ...controlConnection, source: 'B' }, catalog());
    const snapshot = structuredClone(input);
    const edge = toReactFlowEdges(input).find((item) => item.data?.kind === 'control')!;
    expect(() =>
      reconnectWorkflowEdge(
        input,
        edge,
        { ...controlConnection, source: 'B', target: 'A' },
        catalog(),
      ),
    ).toThrow('联合必须无环');
    expect(input).toEqual(snapshot);
  });
});
