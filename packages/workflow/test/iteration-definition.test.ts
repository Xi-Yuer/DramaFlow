import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MemorySaver } from '@langchain/langgraph';
import {
  StringType,
  isNodeVisibleInCatalog,
  NumberType,
  AnyType,
  workflowDefinitionSchema,
  workflowDraftDefinitionSchema,
  type NodeDefinition,
  type DataType,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import {
  NodeRegistry,
  createIterationNodeType,
  createIfNodeType,
  createHumanReviewNodeType,
  validateWorkflowForPublish,
  DefaultWorkflowCompiler,
  type NodeDeclaration,
} from '../src/index.js';
const array = (itemType: DataType): DataType => ({ kind: 'array', itemType });
const node = (id: string, type = 'test.text'): NodeDefinition => ({
  id,
  type,
  typeVersion: 1,
  name: id,
  inputs: { value: { type: 'workflow_input', key: 'chapter' } },
  config: {},
  ui: { position: { x: 0, y: 0 } },
});
function action(type = 'test.text', input: DataType = StringType): NodeDeclaration {
  return {
    manifest: {
      type,
      version: 1,
      executionKind: 'action',
      metadata: { name: '处理', category: 'data' },
      inputs: [{ key: 'value', name: '输入', dataType: input, required: true }],
      outputs: [
        { key: 'text', name: '文本', dataType: StringType },
        { key: 'segments', name: '片段', dataType: array(StringType), storagePolicy: 'inline' },
      ],
      config: [],
    },
    inputSchema: z
      .object({ value: input.kind === 'array' ? z.array(z.string()) : z.string() })
      .strict(),
    outputSchema: z.object({ text: z.string(), segments: z.array(z.string()) }).strict(),
    configSchema: z.object({}).strict(),
    execute: vi.fn(async () => ({ text: 'unused', segments: [] })),
  };
}
function fixture() {
  const text = action();
  const downstream = action('test.downstream', array(StringType));
  const registry = new NodeRegistry([
    text,
    downstream,
    createIterationNodeType(),
    createIfNodeType(),
    createHumanReviewNodeType(),
  ]);
  const iteration = node('iteration', 'flow.iteration');
  iteration.inputs = {
    items: { type: 'workflow_input', key: 'chapters' },
    style: { type: 'workflow_input', key: 'style' },
  };
  iteration.composite = {
    kind: 'iteration',
    itemType: StringType,
    invariantInputs: [{ name: 'style', type: StringType, required: true }],
    body: {
      inputs: [
        { name: 'chapter', type: StringType, required: true },
        { name: 'position', type: NumberType, required: true },
        { name: 'style', type: StringType, required: true },
        { name: 'optional', type: StringType, required: false },
      ],
      nodes: [node('process')],
      edges: [],
      outputs: [
        { name: 'episode', type: StringType, source: { nodeId: 'process', outputKey: 'text' } },
        {
          name: 'segments',
          type: array(StringType),
          source: { nodeId: 'process', outputKey: 'segments' },
        },
      ],
    },
    bodyInputMapping: [
      { target: 'chapter', source: { type: 'current_item' } },
      { target: 'position', source: { type: 'current_index' } },
      { target: 'style', source: { type: 'iteration_input', key: 'style' } },
    ],
  };
  const graph: WorkflowDefinition = {
    inputs: [
      { name: 'chapters', type: array(StringType), required: true },
      { name: 'style', type: StringType, required: true },
    ],
    nodes: [iteration],
    edges: [],
    outputs: [
      {
        name: 'episodes',
        type: array(StringType),
        source: { nodeId: 'iteration', outputKey: 'episode' },
      },
    ],
  };
  return {
    graph,
    iteration,
    composite: iteration.composite,
    body: iteration.composite.body,
    registry,
    text,
  };
}
const check = (f: ReturnType<typeof fixture>) => validateWorkflowForPublish(f.graph, f.registry);
const errorCode = (code: string) => expect.objectContaining({ code });

describe('Iteration Composite Contract / Draft', () => {
  it('正式定义、三种 mapping 和动态端口可发布；校验不执行 Action', () => {
    const f = fixture();
    const hidden = f.registry.get('flow.iteration', 1).manifest;
    expect(hidden.metadata.catalog?.exposure).toBe('internal');
    expect(isNodeVisibleInCatalog(hidden, 'advanced')).toBe(false);
    expect(workflowDefinitionSchema.parse(f.graph)).toEqual(f.graph);
    const validated = check(f);
    expect(validated.map((entry) => entry.node.id)).toEqual(['iteration', 'process']);
    expect(validated[1]!.definitionPath).toEqual([{ nodeId: 'iteration', graphKey: 'body' }]);
    expect(f.text.execute).not.toHaveBeenCalled();
    expect(() => f.registry.getAction('flow.iteration', 1)).toThrow();
  });
  it('Draft 可保存空 body / 未完成 mapping，Publish 明确拒绝', () => {
    const f = fixture();
    f.composite.body = { inputs: [], nodes: [], edges: [], outputs: [] };
    f.composite.bodyInputMapping = [];
    expect(workflowDraftDefinitionSchema.safeParse(f.graph).success).toBe(true);
    expect(() => check(f)).toThrow(errorCode('ITERATION_BODY_EMPTY'));
    delete f.iteration.composite;
    expect(workflowDraftDefinitionSchema.safeParse(f.graph).success).toBe(true);
    expect(() => check(f)).toThrow(errorCode('ITERATION_DEFINITION_REQUIRED'));
  });
  it('Draft 可保留候选不足的 body output，正式 Graph Schema 递归收紧', () => {
    const f = fixture();
    f.body.outputs = [{ name: 'incomplete', type: StringType, sources: [] }];
    expect(workflowDraftDefinitionSchema.safeParse(f.graph).success).toBe(true);
    expect(workflowDefinitionSchema.safeParse(f.graph).success).toBe(false);
  });
  it('拒绝 malformed body、非法 mapping source 和手工 outputs/运行身份字段', () => {
    const f = fixture();
    for (const composite of [
      { ...f.composite, body: [] },
      {
        ...f.composite,
        bodyInputMapping: [
          { target: 'chapter', source: { type: 'parent_state', key: 'chapters' } },
        ],
      },
      { ...f.composite, outputs: [] },
      { ...f.composite, scopeKey: 'root' },
    ])
      expect(
        workflowDraftDefinitionSchema.safeParse({
          ...f.graph,
          nodes: [{ ...f.iteration, composite }],
        }).success,
      ).toBe(false);
  });
  it('输入集合必须有来源且为已知 array 元素类型', () => {
    const f = fixture();
    delete f.iteration.inputs.items;
    expect(() => check(f)).toThrow(errorCode('INPUT_SOURCE_MISSING'));
    f.iteration.inputs.items = { type: 'workflow_input', key: 'style' };
    expect(() => check(f)).toThrow(errorCode('INPUT_TYPE_MISMATCH'));
    f.composite.itemType = AnyType;
    expect(() => check(f)).toThrow(errorCode('ITERATION_ITEM_TYPE_UNRESOLVED'));
  });
  it('空 collection 常量合法，不推断 itemType、不执行 body', () => {
    const f = fixture();
    f.iteration.inputs.items = { type: 'constant', value: [] };
    expect(check(f)).toHaveLength(2);
    expect(f.text.execute).not.toHaveBeenCalled();
  });
});

describe('Iteration input mapping', () => {
  it.each([
    [
      'BODY_INPUT_DUPLICATE',
      (f: ReturnType<typeof fixture>) =>
        f.composite.bodyInputMapping.push(f.composite.bodyInputMapping[0]!),
    ],
    [
      'BODY_INPUT_REQUIRED',
      (f: ReturnType<typeof fixture>) => f.composite.bodyInputMapping.shift(),
    ],
    [
      'BODY_INPUT_UNKNOWN',
      (f: ReturnType<typeof fixture>) =>
        f.composite.bodyInputMapping.push({ target: 'missing', source: { type: 'current_item' } }),
    ],
    [
      'BODY_SOURCE_UNKNOWN',
      (f: ReturnType<typeof fixture>) =>
        (f.composite.bodyInputMapping[2]!.source = { type: 'iteration_input', key: 'missing' }),
    ],
    [
      'BODY_INPUT_TYPE_MISMATCH',
      (f: ReturnType<typeof fixture>) =>
        (f.composite.bodyInputMapping[0]!.source = { type: 'current_index' }),
    ],
    [
      'BODY_SOURCE_OPTIONAL',
      (f: ReturnType<typeof fixture>) => (f.composite.invariantInputs[0]!.required = false),
    ],
    [
      'ITERATION_INPUT_DUPLICATE',
      (f: ReturnType<typeof fixture>) =>
        f.composite.invariantInputs.push({ name: 'items', type: StringType, required: true }),
    ],
  ])('%s', (code, mutate) => {
    const f = fixture();
    mutate(f);
    expect(() => check(f)).toThrow(errorCode(code));
  });
  it('optional body input 可以省略，额外输入通过现有 Binding 校验', () => {
    const f = fixture();
    expect(check(f)).toHaveLength(2);
    f.iteration.inputs.style = { type: 'constant', value: 123 };
    expect(() => check(f)).toThrow(errorCode('INPUT_VALUE_INVALID'));
    f.iteration.inputs.style = {
      type: 'template',
      value: '{{s}}',
      variables: { s: { type: 'workflow_input', key: 'style' } },
    };
    expect(check(f)).toHaveLength(2);
  });
});

describe('动态端口与局部图校验复用', () => {
  it('多命名 outputs 提升为数组，数组输出不 flatten；WorkflowOutput / DataEdge 使用相同推导', () => {
    const f = fixture();
    const ports = f.registry.resolveNodePorts(f.iteration);
    expect(ports.inputs[0]!.dataType).toEqual(array(StringType));
    expect(ports.outputs.map((port) => [port.key, port.dataType])).toEqual([
      ['episode', array(StringType)],
      ['segments', array(array(StringType))],
    ]);
    f.graph.nodes.push({ ...node('consumer', 'test.downstream'), inputs: {} });
    f.graph.edges.push({
      id: 'aggregate',
      kind: 'data',
      source: { nodeId: 'iteration', portKey: 'episode' },
      target: { nodeId: 'consumer', portKey: 'value' },
    });
    expect(check(f)).toHaveLength(3);
    f.graph.nodes[1]!.type = 'test.text';
    expect(() => check(f)).toThrow(errorCode('INPUT_TYPE_MISMATCH'));
  });
  it('Iteration collection 接收普通 DataEdge，不新增 edge 种类', () => {
    const f = fixture();
    f.graph.nodes.unshift({
      ...node('producer'),
      inputs: { value: { type: 'constant', value: 'A' } },
    });
    delete f.iteration.inputs.items;
    f.graph.edges.push({
      id: 'items',
      kind: 'data',
      source: { nodeId: 'producer', portKey: 'segments' },
      target: { nodeId: 'iteration', portKey: 'items' },
    });
    expect(check(f)).toHaveLength(3);
    f.graph.edges[0]!.source.portKey = 'text';
    expect(() => check(f)).toThrow(errorCode('INPUT_TYPE_MISMATCH'));
  });
  it('声明输出不存在或类型伪造时失败', () => {
    const f = fixture();
    f.body.outputs[0]!.type = NumberType;
    expect(() => check(f)).toThrow(errorCode('WORKFLOW_OUTPUT_TYPE_MISMATCH'));
    f.body.outputs[0]!.type = StringType;
    f.graph.outputs[0]!.type = StringType;
    expect(() => check(f)).toThrow(errorCode('WORKFLOW_OUTPUT_TYPE_MISMATCH'));
    f.graph.outputs[0]!.source = { nodeId: 'iteration', outputKey: 'fake' };
    expect(() => check(f)).toThrow(errorCode('OUTPUT_PORT_NOT_FOUND'));
  });
  it.each(['unknown_type', 'node_id', 'input', 'edge_port', 'output_port', 'config'] as const)(
    'body %s 复用同一校验管线',
    (kind) => {
      const f = fixture();
      if (kind === 'unknown_type') f.body.nodes[0]!.type = 'test.unknown';
      if (kind === 'node_id') {
        f.body.nodes[0]!.id = '__start__';
        for (const output of f.body.outputs) if (output.source) output.source.nodeId = '__start__';
      }
      if (kind === 'input') f.body.nodes[0]!.inputs = {};
      if (kind === 'edge_port') {
        f.body.nodes.push({ ...node('second'), inputs: {} });
        f.body.edges.push({
          id: 'bad',
          kind: 'data',
          source: { nodeId: 'process', portKey: 'fake' },
          target: { nodeId: 'second', portKey: 'value' },
        });
      }
      if (kind === 'output_port')
        f.body.outputs[0]!.source = { nodeId: 'process', outputKey: 'fake' };
      if (kind === 'config') f.body.nodes[0]!.config = { unknown: true };
      expect(() => check(f)).toThrow();
    },
  );
  it('body identity、cycle、跨边界引用及父 workflow_input 不可混入', () => {
    for (const kind of ['duplicate', 'cycle', 'parent', 'edge'] as const) {
      const f = fixture();
      if (kind === 'duplicate') f.body.nodes.push(node('process'));
      if (kind === 'cycle') {
        f.body.nodes.push(node('second'));
        f.body.edges = [
          { id: 'a', kind: 'control', source: { nodeId: 'process' }, target: { nodeId: 'second' } },
          { id: 'b', kind: 'control', source: { nodeId: 'second' }, target: { nodeId: 'process' } },
        ];
      }
      if (kind === 'parent')
        f.body.nodes[0]!.inputs.value = { type: 'workflow_input', key: 'chapters' };
      if (kind === 'edge')
        f.body.edges.push({
          id: 'parent',
          kind: 'control',
          source: { nodeId: 'iteration' },
          target: { nodeId: 'process' },
        });
      expect(() => check(f)).toThrow();
    }
  });
  it('body 本地 nodeId 可与 root 相同；Template 使用局部来源，父来源被拒绝', () => {
    const f = fixture();
    f.graph.nodes.push({
      ...node('process'),
      inputs: { value: { type: 'constant', value: 'parent' } },
    });
    f.body.nodes.push({
      ...node('local'),
      inputs: {
        value: {
          type: 'template',
          value: '{{local}}',
          variables: { local: { type: 'node_output', nodeId: 'process', portKey: 'text' } },
        },
      },
    });
    expect(check(f)).toHaveLength(4);
    f.body.nodes[1]!.inputs.value = {
      type: 'template',
      value: '{{parent}}',
      variables: { parent: { type: 'node_output', nodeId: 'iteration', portKey: 'episode' } },
    };
    expect(() => check(f)).toThrow();
  });
  it('Candidate 复用既有互斥来源证明，不因进入 body 放松', () => {
    const f = fixture();
    f.body.nodes.push(
      {
        ...node('candidate'),
        inputs: {
          value: {
            type: 'candidate',
            sources: [
              { type: 'node_output', nodeId: 'process', portKey: 'text' },
              { type: 'node_output', nodeId: 'other', portKey: 'text' },
            ],
          },
        },
      },
      node('other'),
    );
    expect(() => check(f)).toThrow();
  });
  it.each(['flow.iteration', 'flow.human_review', 'flow.if', 'test.composite'] as const)(
    'v1 body 拒绝 %s，Contract 表达不代表 Runtime-ready',
    (type) => {
      const f = fixture();
      const child = node('unsupported', type);
      child.inputs = {};
      if (type === 'test.composite')
        f.registry.register({
          manifest: {
            type,
            version: 1,
            executionKind: 'composite',
            metadata: { name: '不支持', category: 'flow' },
            inputs: [],
            outputs: [],
            config: [],
          },
          inputSchema: z.object({}),
          outputSchema: z.object({}),
          configSchema: z.object({}),
        });
      if (type === 'flow.iteration') child.composite = structuredClone(f.composite);
      f.body.nodes.push(child);
      expect(workflowDefinitionSchema.safeParse(f.graph).success).toBe(true);
      expect(() => check(f)).toThrow(errorCode('ITERATION_BODY_CAPABILITY_UNSUPPORTED'));
    },
  );
  it('缺少 IterationRun Repository 时，在创建执行服务前拒绝 Iteration', async () => {
    const f = fixture();
    const createExecutor = vi.fn();
    const createServices = vi.fn();
    const compiler = new DefaultWorkflowCompiler(
      f.registry,
      createExecutor,
      new MemorySaver(),
      createServices,
    );
    const run = {
      id: 'run',
      projectId: 'project',
      workflowId: 'workflow',
      workflowVersionId: 'version',
      threadId: 'thread',
      invocationKey: 'invocation',
      status: 'pending' as const,
      inputs: {},
      createdAt: '2026-10-24T00:00:00.000Z',
    };
    await expect(compiler.compile(f.graph, run)).rejects.toThrow(
      'Iteration 编译必须注入 IterationRun Repository',
    );
    expect(createExecutor).not.toHaveBeenCalled();
    expect(createServices).not.toHaveBeenCalled();
    expect(f.text.execute).not.toHaveBeenCalled();
  });
});

it('Iteration 不能伪装为 Action，也不能在 Manifest 伪造固定输出', () => {
  const declaration = createIterationNodeType();
  expect(
    () =>
      new NodeRegistry([
        {
          ...declaration,
          manifest: { ...declaration.manifest, executionKind: 'action' },
          execute: vi.fn(),
        },
      ]),
  ).toThrow();
  expect(
    () =>
      new NodeRegistry([
        {
          ...declaration,
          manifest: {
            ...declaration.manifest,
            outputs: [{ key: 'fake', name: '假输出', dataType: StringType }],
          },
        },
      ]),
  ).toThrow();
});
it('body 内不放开带命名控制出口的特殊 Action', () => {
  const f = fixture();
  const declaration = action('test.routing_action');
  f.registry.register({
    ...declaration,
    manifest: { ...declaration.manifest, controlOutputs: [{ key: 'next', name: '下一步' }] },
  });
  f.body.nodes.push(node('route', 'test.routing_action'));
  expect(() => check(f)).toThrow(errorCode('ITERATION_BODY_CAPABILITY_UNSUPPORTED'));
});

it('body 普通 DataEdge / 默认 ControlEdge 复用已有规则，Iteration 未知输入拒绝', () => {
  const f = fixture();
  f.body.nodes.push({ ...node('second'), inputs: {} });
  f.body.edges.push(
    {
      id: 'data',
      kind: 'data',
      source: { nodeId: 'process', portKey: 'text' },
      target: { nodeId: 'second', portKey: 'value' },
    },
    { id: 'control', kind: 'control', source: { nodeId: 'process' }, target: { nodeId: 'second' } },
  );
  expect(check(f)).toHaveLength(3);
  f.iteration.inputs.unknown = { type: 'constant', value: 'x' };
  expect(() => check(f)).toThrow(errorCode('INPUT_PORT_NOT_FOUND'));
});
