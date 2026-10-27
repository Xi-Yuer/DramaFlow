import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  NumberType,
  StringType,
  type GraphDefinition,
  type NodeDefinition,
  type StaticInputBinding,
} from '@dramaflow/contracts';
import {
  NodeRegistry,
  createHumanReviewNodeType,
  createIfNodeType,
  createIterationNodeType,
  createSubworkflowNodeType,
  validateGraphDefinitionSemantics,
  validateWorkflowForPublish,
  type NodeDeclaration,
} from '../../../src/index.js';

function fixture() {
  const execute = vi.fn(async () => ({ text: 'unused', texts: [] }));
  const declaration: NodeDeclaration = {
    manifest: {
      type: 'test.text',
      version: 1,
      executionKind: 'action',
      metadata: { name: '文本', category: 'data' },
      inputs: [{ key: 'value', name: '值', dataType: StringType, required: true }],
      outputs: [
        { key: 'text', name: '文本', dataType: StringType },
        {
          key: 'texts',
          name: '集合',
          dataType: { kind: 'array', itemType: StringType },
          storagePolicy: 'inline',
        },
      ],
      config: [{ key: 'suffix', name: '后缀', type: 'string', required: true }],
      capabilities: [{ type: 'text.generate' }],
    },
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ text: z.string(), texts: z.array(z.string()) }),
    configSchema: z.object({ suffix: z.string() }),
    execute,
  };
  const registry = new NodeRegistry([
    declaration,
    createSubworkflowNodeType(),
    createIterationNodeType(),
  ]);
  const action: NodeDefinition = {
    id: 'process',
    type: 'test.text',
    typeVersion: 1,
    name: '处理',
    inputs: { value: { type: 'workflow_input', key: 'prompt' } },
    config: { suffix: '!' },
    ui: { position: { x: 0, y: 0 } },
  };
  const child: GraphDefinition = {
    inputs: [
      { name: 'prompt', type: StringType, required: true },
      { name: 'style', type: StringType, required: false },
    ],
    nodes: [action],
    edges: [],
    outputs: [
      { name: 'text', type: StringType, source: { nodeId: 'process', outputKey: 'text' } },
      {
        name: 'texts',
        type: { kind: 'array', itemType: StringType },
        source: { nodeId: 'process', outputKey: 'texts' },
      },
    ],
  };
  const call: NodeDefinition = {
    id: 'call',
    type: 'flow.subworkflow',
    typeVersion: 1,
    name: '调用',
    inputs: { prompt: { type: 'workflow_input', key: 'seed' } },
    config: {},
    ui: { position: { x: 0, y: 0 } },
    composite: { kind: 'subworkflow', graph: child },
  };
  const root: GraphDefinition = {
    inputs: [{ name: 'seed', type: StringType, required: true }],
    nodes: [call],
    edges: [],
    outputs: [{ name: 'result', type: StringType, source: { nodeId: 'call', outputKey: 'text' } }],
  };
  return { execute, registry, action, child, call, root };
}
const check = (f: ReturnType<typeof fixture>) =>
  validateGraphDefinitionSemantics(f.root, f.registry);
const code = (value: string) => expect.objectContaining({ code: value });

describe('SubWorkflow 静态语义 / 执行门禁', () => {
  it('静态返回完整后代、路径和 capability，不执行节点，也不能作为 Action 获取', () => {
    const f = fixture();
    const entries = check(f);
    expect(entries.map((entry) => [entry.node.id, entry.definitionPath])).toEqual([
      ['call', undefined],
      ['process', [{ nodeId: 'call', graphKey: 'graph' }]],
    ]);
    expect(entries[1]!.nodeType.manifest.capabilities).toEqual([{ type: 'text.generate' }]);
    expect(f.execute).not.toHaveBeenCalled();
    expect(() => f.registry.getAction('flow.subworkflow', 1)).toThrow();
    expect(f.registry.get('flow.subworkflow', 1).execute).toBeUndefined();
  });
  it.each<StaticInputBinding>([
    { type: 'constant', value: 'hello' },
    { type: 'workflow_input', key: 'seed' },
    {
      type: 'template',
      value: '{{seed}}!',
      variables: { seed: { type: 'workflow_input', key: 'seed' } },
    },
  ])('父绑定沿用 $type', (binding) => {
    const f = fixture();
    f.call.inputs.prompt = binding;
    expect(check(f)).toHaveLength(2);
  });
  it.each(['edge', 'candidate'] as const)('父输入支持既有 %s 来源', (source) => {
    const f = fixture();
    f.root.nodes.unshift(
      {
        ...structuredClone(f.action),
        id: 'left',
        inputs: { value: { type: 'constant', value: 'a' } },
      },
      {
        ...structuredClone(f.action),
        id: 'right',
        inputs: { value: { type: 'constant', value: 'b' } },
      },
    );
    if (source === 'edge') {
      delete f.call.inputs.prompt;
      f.root.edges.push({
        id: 'input',
        kind: 'data',
        source: { nodeId: 'left', portKey: 'text' },
        target: { nodeId: 'call', portKey: 'prompt' },
      });
    } else
      f.call.inputs.prompt = {
        type: 'candidate',
        sources: [
          { type: 'node_output', nodeId: 'left', portKey: 'text' },
          { type: 'node_output', nodeId: 'right', portKey: 'text' },
        ],
      };
    expect(check(f)).toHaveLength(4);
  });
  it('optional 可以省略或来自 optional 输入，required 不能省略或来自 optional', () => {
    const f = fixture();
    expect(check(f)).toHaveLength(2);
    f.root.inputs.push({ name: 'optional', type: StringType, required: false });
    f.call.inputs.style = { type: 'workflow_input', key: 'optional' };
    expect(check(f)).toHaveLength(2);
    delete f.call.inputs.prompt;
    expect(() => check(f)).toThrow(code('INPUT_SOURCE_MISSING'));
    f.call.inputs.prompt = { type: 'workflow_input', key: 'optional' };
    expect(() => check(f)).toThrow(code('INPUT_SOURCE_OPTIONAL'));
  });
  it.each(['constant', 'workflow_input', 'unknown'] as const)('拒绝不合法父输入 %s', (kind) => {
    const f = fixture();
    if (kind === 'constant') f.call.inputs.prompt = { type: 'constant', value: 42 };
    else if (kind === 'workflow_input') f.root.inputs[0]!.type = NumberType;
    else f.call.inputs.unknown = { type: 'constant', value: 'x' };
    expect(() => check(f)).toThrow(
      code(
        kind === 'constant'
          ? 'INPUT_VALUE_INVALID'
          : kind === 'workflow_input'
            ? 'INPUT_TYPE_MISMATCH'
            : 'INPUT_PORT_NOT_FOUND',
      ),
    );
  });
  it.each(['type', 'version', 'config', 'output_port', 'output_type'] as const)(
    '检查 child %s，附带定义路径',
    (kind) => {
      const f = fixture();
      if (kind === 'type') f.action.type = 'test.missing';
      if (kind === 'version') f.action.typeVersion = 2;
      if (kind === 'config') f.action.config.suffix = 42;
      if (kind === 'output_port')
        f.child.outputs[0]!.source = { nodeId: 'process', outputKey: 'missing' };
      if (kind === 'output_type') f.child.outputs[0]!.type = NumberType;
      const expected = {
        type: 'NODE_TYPE_UNAVAILABLE',
        version: 'NODE_TYPE_UNAVAILABLE',
        config: 'NODE_CONFIG_INVALID',
        output_port: 'OUTPUT_PORT_NOT_FOUND',
        output_type: 'WORKFLOW_OUTPUT_TYPE_MISMATCH',
      }[kind];
      expect(() => check(f)).toThrow(
        expect.objectContaining({
          code: expected,
          definitionPath: [{ nodeId: 'call', graphKey: 'graph' }],
        }),
      );
    },
  );
  it('静态可遍历 Iteration → SubWorkflow；Publish 仍拒绝 body composite', () => {
    const f = fixture();
    const loop: NodeDefinition = {
      id: 'loop',
      type: 'flow.iteration',
      typeVersion: 1,
      name: '逐项',
      inputs: { items: { type: 'constant', value: ['x'] } },
      config: {},
      ui: { position: { x: 0, y: 0 } },
      composite: {
        kind: 'iteration',
        itemType: StringType,
        invariantInputs: [],
        bodyInputMapping: [{ target: 'seed', source: { type: 'current_item' } }],
        body: f.root,
      },
    };
    const root: GraphDefinition = { inputs: [], nodes: [loop], edges: [], outputs: [] };
    const entries = validateGraphDefinitionSemantics(root, f.registry);
    expect(entries[2]!.definitionPath).toEqual([
      { nodeId: 'loop', graphKey: 'body' },
      { nodeId: 'call', graphKey: 'graph' },
    ]);
    expect(() => validateWorkflowForPublish(root, f.registry)).toThrow(
      code('ITERATION_BODY_CAPABILITY_UNSUPPORTED'),
    );
  });
  it('v1 子图的普通 Action 可以 Publish，节点本身仍没有 execute', () => {
    const f = fixture();
    expect(check(f)).toHaveLength(2);
    expect(validateWorkflowForPublish(f.root, f.registry)).toHaveLength(2);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.registry.get('flow.subworkflow', 1).execute).toBeUndefined();
  });
  it.each(['input', 'output'] as const)('子图 %s Candidate 在 Publish 明确拒绝', (kind) => {
    const f = fixture();
    const other = { ...structuredClone(f.action), id: 'other', name: '另一来源' };
    f.child.nodes.push(other);
    if (kind === 'input')
      f.child.nodes.push({
        ...structuredClone(f.action),
        id: 'join',
        inputs: {
          value: {
            type: 'candidate',
            sources: [
              { type: 'node_output', nodeId: 'process', portKey: 'text' },
              { type: 'node_output', nodeId: 'other', portKey: 'text' },
            ],
          },
        },
      });
    else
      f.child.outputs[0] = {
        name: 'text',
        type: StringType,
        sources: [
          { nodeId: 'process', outputKey: 'text' },
          { nodeId: 'other', outputKey: 'text' },
        ],
      };
    expect(() => validateWorkflowForPublish(f.root, f.registry)).toThrow(
      expect.objectContaining({
        code: 'SUBWORKFLOW_GRAPH_CANDIDATE_UNSUPPORTED',
        nodeId: kind === 'input' ? 'join' : 'text',
        ...(kind === 'input' ? { portKey: 'value' } : {}),
        definitionPath: [{ nodeId: 'call', graphKey: 'graph' }],
      }),
    );
  });
  it.each([
    'flow.if',
    'flow.human_review',
    'flow.iteration',
    'flow.subworkflow',
    'test.control',
  ] as const)('子图拒绝 %s，不留到运行期', (type) => {
    const f = fixture();
    f.registry.register(createIfNodeType());
    f.registry.register(createHumanReviewNodeType());
    if (type === 'test.control')
      f.registry.register({
        manifest: {
          type,
          version: 1,
          executionKind: 'action',
          metadata: { name: '带控制出口', category: 'flow' },
          inputs: [],
          outputs: [],
          controlOutputs: [{ key: 'next', name: '下一步' }],
          config: [],
        },
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        configSchema: z.object({}),
        execute: async () => ({}),
      });
    f.child.nodes = [
      {
        id: 'blocked',
        type,
        typeVersion: 1,
        name: '不允许',
        inputs: {},
        config: {},
        ui: { position: { x: 0, y: 0 } },
        ...(type === 'flow.iteration'
          ? {
              composite: {
                kind: 'iteration' as const,
                itemType: StringType,
                invariantInputs: [],
                bodyInputMapping: [],
                body: { inputs: [], nodes: [], edges: [], outputs: [] },
              },
            }
          : type === 'flow.subworkflow'
            ? {
                composite: {
                  kind: 'subworkflow' as const,
                  graph: { inputs: [], nodes: [], edges: [], outputs: [] },
                },
              }
            : {}),
      },
    ];
    f.child.outputs = [];
    expect(() => validateWorkflowForPublish(f.root, f.registry)).toThrow(
      expect.objectContaining({
        code: 'SUBWORKFLOW_GRAPH_CAPABILITY_UNSUPPORTED',
        nodeId: 'blocked',
        definitionPath: [{ nodeId: 'call', graphKey: 'graph' }],
      }),
    );
  });
});
