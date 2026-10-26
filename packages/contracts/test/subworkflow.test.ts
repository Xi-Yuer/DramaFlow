import { describe, expect, it } from 'vitest';
import {
  StringType,
  compositeDefinitionSchema,
  nodeDefinitionSchema,
  nodeTypeManifestSchema,
  resolveNodePorts,
  walkGraphDefinitions,
  workflowDefinitionSchema,
  workflowDraftDefinitionSchema,
  type GraphDefinition,
  type NodeDefinition,
  type NodeTypeManifest,
} from '../src/index.js';

const action: NodeDefinition = {
  id: 'format',
  type: 'data.test',
  typeVersion: 1,
  name: '处理',
  inputs: { text: { type: 'workflow_input', key: 'prompt' } },
  config: {},
  ui: { position: { x: 0, y: 0 } },
};
function fixture() {
  const child: GraphDefinition = {
    inputs: [
      { name: 'prompt', type: StringType, required: true },
      { name: 'style', type: StringType, required: false },
    ],
    nodes: [structuredClone(action)],
    edges: [],
    outputs: [
      { name: 'text', type: StringType, source: { nodeId: 'format', outputKey: 'text' } },
      {
        name: 'texts',
        type: { kind: 'array', itemType: StringType },
        source: { nodeId: 'format', outputKey: 'texts' },
      },
    ],
  };
  const node: NodeDefinition = {
    id: 'call',
    type: 'flow.subworkflow',
    typeVersion: 1,
    name: '子流程',
    inputs: { prompt: { type: 'constant', value: 'x' } },
    config: {},
    ui: { position: { x: 0, y: 0 } },
    composite: { kind: 'subworkflow', graph: child },
  };
  const graph: GraphDefinition = {
    inputs: [],
    nodes: [node],
    edges: [],
    outputs: [{ name: 'result', type: StringType, source: { nodeId: 'call', outputKey: 'text' } }],
  };
  return { child, node, graph };
}
const manifest: NodeTypeManifest = {
  type: 'flow.subworkflow',
  version: 1,
  executionKind: 'composite',
  portDerivation: 'subworkflow',
  metadata: { name: '子流程', category: 'flow' },
  inputs: [],
  outputs: [],
  config: [],
};

describe('内嵌 SubWorkflow Definition', () => {
  it('正式及 Draft schema 保留 graph 和原有父 binding，不注入映射或运行字段', () => {
    const f = fixture();
    expect(workflowDefinitionSchema.parse(f.graph)).toEqual(f.graph);
    expect(workflowDraftDefinitionSchema.parse(f.graph)).toEqual(f.graph);
    expect(compositeDefinitionSchema.parse(f.node.composite)).toEqual({
      kind: 'subworkflow',
      graph: f.child,
    });
  });
  it.each([
    'workflowId',
    'workflowVersionId',
    'item',
    'index',
    'concurrency',
    'retry',
    'inputMapping',
    'outputMapping',
    'scopeKey',
  ])('拒绝专属字段 %s', (key) => {
    const f = fixture();
    expect(
      compositeDefinitionSchema.safeParse({ ...f.node.composite, [key]: 'forbidden' }).success,
    ).toBe(false);
  });
  it('拒绝缺失 graph、混用 kind / slot、错误 node type/version 和非法 graph', () => {
    const f = fixture();
    for (const composite of [
      { kind: 'subworkflow' },
      { kind: 'subworkflow', body: f.child },
      { kind: 'iteration', graph: f.child },
      { kind: 'other', graph: f.child },
      { kind: 'subworkflow', graph: {} },
    ])
      expect(compositeDefinitionSchema.safeParse(composite).success).toBe(false);
    expect(nodeDefinitionSchema.safeParse({ ...f.node, type: 'flow.iteration' }).success).toBe(
      false,
    );
    expect(nodeDefinitionSchema.safeParse({ ...f.node, typeVersion: 2 }).success).toBe(false);
  });
  it('动态输入保持 required/optional，输出保持原类型，数组不再提升', () => {
    const f = fixture();
    expect(resolveNodePorts(f.node, manifest)).toEqual({
      inputs: [
        { key: 'prompt', name: 'prompt', dataType: StringType, required: true },
        { key: 'style', name: 'style', dataType: StringType, required: false },
      ],
      outputs: [
        { key: 'text', name: 'text', dataType: StringType },
        { key: 'texts', name: 'texts', dataType: { kind: 'array', itemType: StringType } },
      ],
    });
    expect(() => resolveNodePorts({ ...f.node, composite: undefined }, manifest)).toThrow();
  });
  it('Manifest 不能伪装 Action 或固定端口，也不能借用其他类型的 derivation', () => {
    expect(nodeTypeManifestSchema.parse(manifest)).toEqual(manifest);
    for (const change of [
      { executionKind: 'action' },
      { portDerivation: undefined },
      { type: 'test.fake' },
      { outputs: [{ key: 'text', name: '文本', dataType: StringType }] },
      { inputs: [{ key: 'prompt', name: '提示', dataType: StringType }] },
    ])
      expect(nodeTypeManifestSchema.safeParse({ ...manifest, ...change }).success).toBe(false);
  });
  it('统一遍历 root / Iteration.body / SubWorkflow.graph，静态路径与局部同名节点独立', () => {
    const f = fixture();
    const iteration: NodeDefinition = {
      ...f.node,
      id: 'iterate',
      type: 'flow.iteration',
      inputs: { items: { type: 'constant', value: [] } },
      composite: {
        kind: 'iteration',
        itemType: StringType,
        invariantInputs: [],
        bodyInputMapping: [],
        body: f.graph,
      },
    };
    const root: GraphDefinition = { inputs: [], nodes: [iteration], edges: [], outputs: [] };
    expect(workflowDefinitionSchema.safeParse(root).success).toBe(true);
    expect([...walkGraphDefinitions(root)].map(({ path }) => path)).toEqual([
      [],
      [{ nodeId: 'iterate', graphKey: 'body' }],
      [
        { nodeId: 'iterate', graphKey: 'body' },
        { nodeId: 'call', graphKey: 'graph' },
      ],
    ]);
  });
  it('子图引用、联合 DAG、重复输入与 output source 均受现有 schema 约束', () => {
    for (const mutate of [
      (g: GraphDefinition) => (g.outputs[0]!.source = { nodeId: 'missing', outputKey: 'text' }),
      (g: GraphDefinition) => g.inputs.push(g.inputs[0]!),
      (g: GraphDefinition) =>
        g.edges.push({
          id: 'self',
          kind: 'control',
          source: { nodeId: 'format' },
          target: { nodeId: 'format' },
        }),
      (g: GraphDefinition) =>
        (g.nodes[0]!.inputs.text = { type: 'workflow_input', key: 'missing' }),
    ]) {
      const f = fixture();
      mutate(f.child);
      const parsed = workflowDefinitionSchema.safeParse(f.graph);
      expect(parsed.success).toBe(false);
      if (!parsed.success)
        expect(parsed.error.issues.some((issue) => issue.path.includes('graph'))).toBe(true);
    }
  });
});
