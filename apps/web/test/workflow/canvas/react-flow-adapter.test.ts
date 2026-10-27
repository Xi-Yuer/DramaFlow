import { describe, expect, it } from 'vitest';
import {
  applyWorkflowNodePositions,
  connectWorkflowNodes,
  disconnectWorkflowEdge,
  fromReactFlowEdge,
  fromReactFlowNode,
  reconnectWorkflowEdge,
  staticBindingForDataConnection,
  toReactFlowEdge,
  toReactFlowEdges,
  toReactFlowNode,
  toReactFlowNodes,
} from '../../../src/features/workflow/canvas/react-flow-adapter';
import {
  nodeDefinitionSchema,
  workflowDefinitionSchema,
  dataEdgeDefinitionSchema,
  type NodeTypeManifest,
  type WorkflowDefinition,
} from '@dramaflow/contracts';

// 所有节点均为协议测试样例，不注册到生产目录或画布。
function definition() {
  return nodeDefinitionSchema.parse({
    id: 'storyboard',
    type: 'ai.llm',
    typeVersion: 1,
    name: '生成分镜',
    preset: 'storyboard-generator',
    inputs: {
      style: { type: 'constant', value: '黑白' },
      novel: { type: 'workflow_input', key: 'novel' },
      reference: { type: 'asset', assetId: 'image-v1', versionId: 'asset-version-1' },
    },
    config: { prompt: '生成分镜', reference: { colors: ['黑白'] } },
    ui: { position: { x: 120, y: -40 } },
  });
}

function workflow(): WorkflowDefinition {
  return {
    inputs: [{ name: 'novel', type: { kind: 'primitive', name: 'string' }, required: true }],
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
      {
        id: 'script-edge',
        kind: 'data',
        source: { nodeId: 'script', portKey: 'text' },
        target: { nodeId: 'storyboard', portKey: 'script' },
      },
    ],
    outputs: [],
  };
}

function manifests(): NodeTypeManifest[] {
  return [
    {
      type: 'ai.llm',
      version: 1,
      executionKind: 'action',
      metadata: { name: '文本', category: 'ai' },
      inputs: [
        { key: 'script', name: '剧本', dataType: { kind: 'primitive', name: 'string' } },
        { key: 'style', name: '风格', dataType: { kind: 'primitive', name: 'string' } },
        { key: 'novel', name: '小说', dataType: { kind: 'primitive', name: 'string' } },
        { key: 'reference', name: '参考', dataType: { kind: 'named', name: 'media.image' } },
      ],
      outputs: [
        { key: 'text', name: '文本', dataType: { kind: 'primitive', name: 'string' } },
        { key: 'newText', name: '新文本', dataType: { kind: 'primitive', name: 'string' } },
        { key: 'picture', name: '图片', dataType: { kind: 'named', name: 'media.image' } },
      ],
      config: [],
    },
  ];
}

const connection = {
  source: 'script',
  sourceHandle: 'text',
  target: 'storyboard',
  targetHandle: 'style',
};
const confirmed = { replaceBinding: true };

function styleEdge(input: WorkflowDefinition) {
  return toReactFlowEdges(input).find((edge) => edge.targetHandle === 'style')!;
}

describe('React Flow 节点协议适配', () => {
  it('区分渲染器与运行类型，往返保留三种静态绑定、Preset、配置和坐标', () => {
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

  it('转换隔离嵌套配置与静态绑定，视图编辑不改变领域快照', () => {
    const input = definition();
    const node = toReactFlowNode(input);
    input.inputs.style = { type: 'constant', value: '青色' };
    input.config.reference = { colors: ['青色'] };
    input.ui.position.x = 900;
    expect(node.data.inputs.style).toEqual({ type: 'constant', value: '黑白' });
    expect(node.data.config.reference).toEqual({ colors: ['黑白'] });
    const exported = fromReactFlowNode(node);
    node.data.inputs.style = { type: 'constant', value: '彩色' };
    node.data.config.prompt = '另一提示词';
    node.position.y = 500;
    expect(exported.inputs.style).toEqual({ type: 'constant', value: '黑白' });
    expect(exported.config.prompt).toBe('生成分镜');
    expect(exported.ui.position.y).toBe(-40);
  });

  it.each([NaN, Infinity, -Infinity])('导入与导出均拒绝非有限坐标 %s', (x) => {
    expect(() => toReactFlowNode({ ...definition(), ui: { position: { x, y: 0 } } })).toThrow();
    expect(() =>
      fromReactFlowNode({ ...toReactFlowNode(definition()), position: { x: 0, y: x } }),
    ).toThrow();
  });

  it('导出拒绝旧 connection 绑定与非 JSON 配置', () => {
    const node = toReactFlowNode(definition());
    expect(() =>
      fromReactFlowNode({
        ...node,
        data: {
          ...node.data,
          inputs: { script: { type: 'connection', nodeId: 'script', outputKey: 'text' } },
        },
      }),
    ).toThrow();
    expect(() =>
      fromReactFlowNode({ ...node, data: { ...node.data, config: { invoke: () => 'text' } } }),
    ).toThrow();
  });
});

describe('React Flow 与一等 Data Edge 无损适配', () => {
  it('边只从 Workflow.edges 映射，保留领域 ID 与两端 portKey', () => {
    const input = workflow();
    const edges = toReactFlowEdges(input);
    expect(edges).toEqual([
      {
        id: 'script-edge',
        source: 'script',
        sourceHandle: 'text',
        target: 'storyboard',
        targetHandle: 'script',
        data: { kind: 'data' },
        type: 'workflowEdge',
        animated: false,
        markerEnd: { type: 'arrowclosed', width: 14, height: 14, color: '#729d99' },
      },
    ]);
    expect(edges.map(fromReactFlowEdge)).toEqual(input.edges);
    expect(input.nodes[1].inputs).not.toHaveProperty('script');
    expect(toReactFlowEdges({ ...input, edges: [] })).toEqual([]);
  });

  it('边导出剔除临时字段并拒绝缺失 Handle 和旧控制边', () => {
    const edge = toReactFlowEdges(workflow())[0];
    expect(fromReactFlowEdge({ ...edge, selected: true, animated: true, style: {} })).toEqual(
      workflow().edges[0],
    );
    for (const extra of [
      { id: '' },
      { sourceHandle: null },
      { targetHandle: undefined },
      { sourceHandle: 'bad-port' },
      { data: { kind: 'control' } },
    ]) {
      expect(() => fromReactFlowEdge({ ...edge, ...extra })).toThrow();
    }
  });

  it('图片生成.image → 图生视频.image 序列化仅保存一条 edges 关系', () => {
    const input = workflow();
    input.nodes[0].id = 'image-generator';
    input.nodes[0].type = 'image.generate';
    input.nodes[1].id = 'image-to-video';
    input.nodes[1].type = 'video.image_to_video';
    input.nodes[1].inputs = {};
    input.edges = [];
    const catalog: NodeTypeManifest[] = [
      {
        ...manifests()[0],
        type: 'image.generate',
        inputs: [],
        outputs: [{ key: 'image', name: '图片', dataType: { kind: 'named', name: 'media.image' } }],
      },
      {
        ...manifests()[0],
        type: 'video.image_to_video',
        inputs: [{ key: 'image', name: '图片', dataType: { kind: 'named', name: 'media.image' } }],
        outputs: [],
      },
    ];
    const connected = connectWorkflowNodes(
      input,
      {
        source: 'image-generator',
        sourceHandle: 'image',
        target: 'image-to-video',
        targetHandle: 'image',
      },
      catalog,
    );
    const saved = workflowDefinitionSchema.parse(JSON.parse(JSON.stringify(connected)));
    expect(saved.edges).toEqual([
      {
        id: expect.any(String),
        kind: 'data',
        source: { nodeId: 'image-generator', portKey: 'image' },
        target: { nodeId: 'image-to-video', portKey: 'image' },
      },
    ]);
    expect(saved.nodes[1].inputs).not.toHaveProperty('image');
    expect(toReactFlowEdges(saved).map(fromReactFlowEdge)).toEqual(saved.edges);
  });
});

describe('Data Edge 连线校验', () => {
  it('显式连线写入 edges 并替换该端口静态来源，不修改原对象或其他输入', () => {
    const input = workflow();
    const result = connectWorkflowNodes(input, connection, manifests(), confirmed);
    expect(result.nodes[1].inputs).not.toHaveProperty('style');
    expect(result.nodes[1].inputs.novel).toEqual(input.nodes[1].inputs.novel);
    expect(input.nodes[1].inputs.style).toEqual({ type: 'constant', value: '黑白' });
    expect(result.edges).toHaveLength(2);
    expect(result.edges[1]).toMatchObject({
      kind: 'data',
      source: { nodeId: 'script', portKey: 'text' },
      target: { nodeId: 'storyboard', portKey: 'style' },
    });
    expect(new Set(result.edges.map((edge) => edge.id)).size).toBe(2);
    expect(() => connectWorkflowNodes(result, connection, manifests())).toThrow('已经存在连接');
  });

  it('空端口可以直接连接；已有 constant、template、workflow_input 或 asset 时必须确认后才替换', () => {
    const occupied = workflow();
    const snapshot = structuredClone(occupied);
    expect(staticBindingForDataConnection(occupied, connection)).toEqual({
      type: 'constant',
      value: '黑白',
    });
    expect(() => connectWorkflowNodes(occupied, connection, manifests())).toThrow('确认替换');
    expect(() =>
      reconnectWorkflowEdge(occupied, toReactFlowEdges(occupied)[0], connection, manifests()),
    ).toThrow('确认替换');
    expect(occupied).toEqual(snapshot);

    const template = structuredClone(occupied);
    template.nodes[1].inputs.style = {
      type: 'template',
      value: '风格 {{text}}',
      variables: { text: { type: 'node_output', nodeId: 'script', portKey: 'text' } },
    };
    const templateSnapshot = structuredClone(template);
    expect(staticBindingForDataConnection(template, connection)?.type).toBe('template');
    expect(() => connectWorkflowNodes(template, connection, manifests())).toThrow('确认替换');
    expect(template).toEqual(templateSnapshot);

    expect(() =>
      connectWorkflowNodes(occupied, { ...connection, targetHandle: 'novel' }, manifests()),
    ).toThrow('确认替换');
    expect(() =>
      connectWorkflowNodes(
        occupied,
        { ...connection, sourceHandle: 'picture', targetHandle: 'reference' },
        manifests(),
      ),
    ).toThrow('确认替换');
    expect(occupied.nodes[1].inputs.novel).toEqual({ type: 'workflow_input', key: 'novel' });
    expect(occupied.nodes[1].inputs.reference).toEqual({
      type: 'asset',
      assetId: 'image-v1',
      versionId: 'asset-version-1',
    });

    const empty = workflow();
    delete empty.nodes[1].inputs.style;
    expect(staticBindingForDataConnection(empty, connection)).toBeUndefined();
    const connected = connectWorkflowNodes(empty, connection, manifests());
    expect(connected.nodes[1].inputs).not.toHaveProperty('style');
    expect(connected.edges).toHaveLength(2);
    expect(connected.nodes[1].inputs.novel).toEqual(empty.nodes[1].inputs.novel);
    expect(
      staticBindingForDataConnection(occupied, {
        sourceHandle: 'control:source',
        target: 'storyboard',
        targetHandle: 'control:target',
      }),
    ).toBeUndefined();
  });

  it.each([undefined, null, '', 'bad-handle'])('连接拒绝缺失或非法端口 %s', (handle) => {
    expect(() =>
      connectWorkflowNodes(workflow(), { ...connection, sourceHandle: handle }, manifests()),
    ).toThrow();
    expect(() =>
      connectWorkflowNodes(workflow(), { ...connection, targetHandle: handle }, manifests()),
    ).toThrow();
  });

  it('连接拒绝不存在的端点和自连接', () => {
    expect(() =>
      connectWorkflowNodes(workflow(), { ...connection, source: 'missing' }, manifests()),
    ).toThrow('来源节点');
    expect(() =>
      connectWorkflowNodes(workflow(), { ...connection, target: 'missing' }, manifests()),
    ).toThrow('目标节点');
    expect(() =>
      connectWorkflowNodes(workflow(), { ...connection, target: 'script' }, manifests()),
    ).toThrow('不能连接自身');
  });

  it('连接拒绝未声明的端口和不兼容的类型', () => {
    expect(() =>
      connectWorkflowNodes(workflow(), { ...connection, sourceHandle: 'missingPort' }, manifests()),
    ).toThrow('来源端口');
    expect(() =>
      connectWorkflowNodes(workflow(), { ...connection, targetHandle: 'missingPort' }, manifests()),
    ).toThrow('目标端口');
    expect(() =>
      connectWorkflowNodes(
        workflow(),
        { ...connection, sourceHandle: 'picture', targetHandle: 'style' },
        manifests(),
      ),
    ).toThrow('端口类型不兼容');
    expect(() => connectWorkflowNodes(workflow(), connection, [])).toThrow('节点类型不可用');
  });

  it('连接目录必须按类型版本唯一，不以数组顺序选择冲突的端口契约', () => {
    const compatible = manifests()[0];
    const conflicting: NodeTypeManifest = {
      ...compatible,
      outputs: [{ key: 'text', name: '图片', dataType: { kind: 'named', name: 'media.image' } }],
    };
    const input = workflow();
    const snapshot = structuredClone(input);
    for (const catalog of [
      [compatible, conflicting],
      [conflicting, compatible],
    ]) {
      expect(() => connectWorkflowNodes(input, connection, catalog)).toThrow('重复类型版本');
      expect(input).toEqual(snapshot);
    }
  });

  it('目标节点的类型版本不可用时拒绝连接，不回退来源节点的版本', () => {
    const input = workflow();
    input.nodes[1].typeVersion = 2;
    expect(() => connectWorkflowNodes(input, connection, manifests())).toThrow('节点类型不可用');
    const older = manifests()[0];
    const newer: NodeTypeManifest = {
      ...older,
      version: 2,
      inputs: older.inputs.map((port) =>
        port.key === 'style' ? { ...port, dataType: { kind: 'named', name: 'media.image' } } : port,
      ),
    };
    expect(() => connectWorkflowNodes(input, connection, [older, newer])).toThrow('端口类型不兼容');
    expect(
      connectWorkflowNodes(
        input,
        { ...connection, sourceHandle: 'picture' },
        [older, newer],
        confirmed,
      ).edges[1],
    ).toMatchObject({ source: { nodeId: 'script', portKey: 'picture' } });
  });

  it('显式连接遵守 any 的单向及数组元素兼容规则', () => {
    const catalog = manifests();
    catalog[0].outputs[0].dataType = { kind: 'any' };
    expect(() => connectWorkflowNodes(workflow(), connection, catalog)).toThrow('端口类型不兼容');
    catalog[0].inputs[1].dataType = { kind: 'any' };
    expect(connectWorkflowNodes(workflow(), connection, catalog, confirmed).edges).toHaveLength(2);
    catalog[0].outputs[0].dataType = { kind: 'array', itemType: { kind: 'any' } };
    catalog[0].inputs[1].dataType = {
      kind: 'array',
      itemType: { kind: 'named', name: 'media.image' },
    };
    expect(() => connectWorkflowNodes(workflow(), connection, catalog)).toThrow('端口类型不兼容');
    catalog[0].outputs[0].dataType = {
      kind: 'array',
      itemType: { kind: 'named', name: 'media.image' },
    };
    catalog[0].inputs[1].dataType = { kind: 'array', itemType: { kind: 'any' } };
    const result = connectWorkflowNodes(workflow(), connection, catalog, confirmed);
    expect(result.edges).toHaveLength(2);
    catalog[0].outputs[1].dataType = catalog[0].outputs[0].dataType;
    expect(() =>
      connectWorkflowNodes(result, { ...connection, sourceHandle: 'newText' }, catalog),
    ).toThrow('已经存在连接');
  });

  it('标量不能接入数组端口，不隐式聚合；数据边不能形成环', () => {
    const catalog = manifests();
    catalog[0].inputs[1].dataType = {
      kind: 'array',
      itemType: { kind: 'primitive', name: 'string' },
    };
    expect(() => connectWorkflowNodes(workflow(), connection, catalog)).toThrow('端口类型不兼容');
    expect(() =>
      connectWorkflowNodes(
        workflow(),
        { ...connection, source: 'storyboard', target: 'script' },
        manifests(),
      ),
    ).toThrow('联合必须无环');
  });
});

describe('Data Edge 删除与重连', () => {
  it('断连只删除对应 edges 关系，不改变节点静态输入', () => {
    const input = connectWorkflowNodes(workflow(), connection, manifests(), confirmed);
    const result = disconnectWorkflowEdge(input, styleEdge(input));
    expect(result.edges).toEqual(workflow().edges);
    expect(result.nodes).toEqual(input.nodes);
    expect(input.edges).toHaveLength(2);
  });

  it('重连保留领域 ID，旧删除/重连事件不影响新关系', () => {
    const input = workflow();
    const edge = toReactFlowEdges(input)[0];
    const updated = reconnectWorkflowEdge(
      input,
      edge,
      { ...connection, targetHandle: 'script', sourceHandle: 'newText' },
      manifests(),
    );
    expect(updated.edges).toEqual([
      {
        ...input.edges[0],
        source: { nodeId: 'script', portKey: 'newText' },
      },
    ]);
    expect(disconnectWorkflowEdge(updated, edge)).toEqual(updated);
    expect(reconnectWorkflowEdge(updated, edge, connection, manifests())).toEqual(updated);
    expect(input).toEqual(workflow());
    expect(
      disconnectWorkflowEdge(updated, { ...toReactFlowEdges(updated)[0], id: 'wrong-id' }),
    ).toEqual(updated);
  });

  it('删除后重新连接相同端点有新 ID，过期事件不能删除新边', () => {
    const input = workflow();
    const edge = toReactFlowEdges(input)[0];
    const removed = disconnectWorkflowEdge(input, edge);
    const updated = connectWorkflowNodes(
      removed,
      { ...connection, targetHandle: 'script' },
      manifests(),
    );
    expect(updated.edges[0].id).not.toBe(edge.id);
    expect(disconnectWorkflowEdge(updated, edge)).toEqual(updated);
  });

  it('重连替换新目标的静态来源，保留其他输入与旧目标空态', () => {
    const input = workflow();
    const result = reconnectWorkflowEdge(
      input,
      toReactFlowEdges(input)[0],
      connection,
      manifests(),
      confirmed,
    );
    expect(result.edges[0].id).toBe(input.edges[0].id);
    expect(result.edges[0].target.portKey).toBe('style');
    expect(result.nodes[1].inputs).not.toHaveProperty('style');
    expect(result.nodes[1].inputs).not.toHaveProperty('script');
    expect(result.nodes[1].inputs.novel).toEqual(input.nodes[1].inputs.novel);
    expect(input.nodes[1].inputs.style).toEqual({ type: 'constant', value: '黑白' });
  });

  it('重连失败保留旧边及静态输入，不因先断连而丢失数据', () => {
    const input = connectWorkflowNodes(workflow(), connection, manifests(), confirmed);
    const snapshot = structuredClone(input);
    const edge = toReactFlowEdges(input)[0];
    expect(() => reconnectWorkflowEdge(input, edge, connection, manifests())).toThrow(
      '已经存在连接',
    );
    const catalog = manifests();
    catalog[0].outputs[2].dataType = { kind: 'primitive', name: 'number' };
    expect(() =>
      reconnectWorkflowEdge(
        input,
        edge,
        { ...connection, sourceHandle: 'picture', targetHandle: 'novel' },
        catalog,
      ),
    ).toThrow('端口类型不兼容');
    expect(() =>
      reconnectWorkflowEdge(
        input,
        edge,
        { ...connection, source: 'storyboard', target: 'script', targetHandle: 'style' },
        manifests(),
      ),
    ).toThrow('联合必须无环');
    expect(input).toEqual(snapshot);
    expect(input.nodes[1].inputs.novel).toEqual({ type: 'workflow_input', key: 'novel' });
  });

  it('无改动重连保持同一关系，重连无效旧快照不会新增边', () => {
    const input = workflow();
    const edge = toReactFlowEdges(input)[0];
    expect(
      reconnectWorkflowEdge(input, edge, { ...connection, targetHandle: 'script' }, manifests()),
    ).toEqual(input);
    expect(
      reconnectWorkflowEdge(input, { ...edge, targetHandle: 'novel' }, connection, manifests()),
    ).toEqual(input);
  });

  it('端点快照和领域对象相互隔离', () => {
    const domain = dataEdgeDefinitionSchema.parse(workflow().edges[0]);
    const edge = toReactFlowEdge(domain);
    domain.source.portKey = 'newText';
    expect(edge.sourceHandle).toBe('text');
    const exported = fromReactFlowEdge(edge);
    edge.targetHandle = 'style';
    expect(exported.target.portKey).toBe('script');
  });
});

describe('持久化草稿的位置编辑', () => {
  it('仅更新位置，保留完整输入输出、配置、Preset 和两类边；不改变原快照', () => {
    const input = workflow();
    input.outputs = [
      {
        name: 'result',
        type: { kind: 'primitive', name: 'string' },
        source: { nodeId: 'storyboard', outputKey: 'text' },
      },
    ];
    input.edges.push({
      id: 'control',
      kind: 'control',
      source: { nodeId: 'script', portKey: 'done' },
      target: { nodeId: 'storyboard', portKey: 'start' },
    });
    const snapshot = structuredClone(input);
    const result = applyWorkflowNodePositions(input, [
      { type: 'select', id: 'script', selected: true },
      { type: 'dimensions', id: 'script', dimensions: { width: 320, height: 180 } },
      { type: 'position', id: 'storyboard', position: { x: 333, y: 444 }, dragging: true },
      { type: 'remove', id: 'script' },
    ]);
    const expected = structuredClone(input);
    expected.nodes[1].ui.position = { x: 333, y: 444 };
    expect(result).toEqual(expected);
    expect(input).toEqual(snapshot);
    expect(
      workflowDefinitionSchema.parse({
        ...result,
        nodes: toReactFlowNodes(result).map(fromReactFlowNode),
        edges: toReactFlowEdges(result).map(fromReactFlowEdge),
      }),
    ).toEqual(expected);
  });
  it('不要求节点可发布，但拒绝非有限坐标', () => {
    const input = workflow();
    expect(
      applyWorkflowNodePositions(input, [
        { type: 'position', id: 'script', position: { x: 12, y: 34 } },
      ]).nodes[0].config,
    ).toEqual({});
    expect(() =>
      applyWorkflowNodePositions(input, [
        { type: 'position', id: 'script', position: { x: NaN, y: 0 } },
      ]),
    ).toThrow();
    expect(input).toEqual(workflow());
  });
});
