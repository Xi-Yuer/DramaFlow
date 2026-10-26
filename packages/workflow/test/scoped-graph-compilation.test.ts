import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { StateGraph } from '@langchain/langgraph';
import {
  StringType,
  NumberType,
  type GraphDefinition,
  type NodeDefinition,
  type RuntimeValue,
} from '@dramaflow/contracts';
import {
  ActionNodeCompilationStrategy,
  createIfNodeType,
  createIterationNodeType,
  createSubworkflowNodeType,
  DefaultDataStoragePolicyResolver,
  DefaultNodeExecutor,
  DefaultRuntimeValueCodec,
  createBindingResolver,
  createLocalGraphInvocation,
  NodeRegistry,
  WorkflowStateAnnotation,
  type WorkflowState,
  type NodeExecutionContext,
} from '../src/index.js';
import { HumanReviewNodeCompilationStrategy } from '../src/compiler/human-review/strategy.js';
import { IfNodeCompilationStrategy } from '../src/compiler/if/strategy.js';
import { IterationNodeCompilationStrategy } from '../src/compiler/iteration/strategy.js';
import {
  analyzeGraphCompilation,
  childGraphDefinitionLocation,
  prepareGraphCompilation,
  type GraphCompilationLocation,
} from '../src/compiler/graph/compilation-plan.js';
import { compileGraph } from '../src/compiler/graph/graph-compiler.js';
import { SubWorkflowNodeCompilationStrategy } from '../src/compiler/subworkflow/strategy.js';
import { auditedNodeRunRepositoryFixture } from './node-run-fixture.js';
import { iterationRuntimeFixture } from './iteration-runtime-fixture.js';

function strategies() {
  return {
    action: new ActionNodeCompilationStrategy(),
    if: new IfNodeCompilationStrategy(),
    review: new HumanReviewNodeCompilationStrategy(),
    iteration: new IterationNodeCompilationStrategy(),
    subworkflow: new SubWorkflowNodeCompilationStrategy(),
  };
}
function textNode(id: string, value = id): NodeDefinition {
  return {
    id,
    type: 'test.echo',
    typeVersion: 1,
    name: id,
    inputs: { value: { type: 'constant', value } },
    config: {},
    ui: { position: { x: 0, y: 0 } },
  };
}
function graph(
  nodes: NodeDefinition[],
  edges: GraphDefinition['edges'] = [],
  outputs: GraphDefinition['outputs'] = [],
): GraphDefinition {
  return { inputs: [], nodes, edges, outputs };
}
const text = (value: string): RuntimeValue => ({ storage: 'inline', type: StringType, value });
const location: GraphCompilationLocation = {
  workflowVersionId: 'version',
  path: [{ nodeId: 'owner', graphKey: 'body' }],
};
function fixture() {
  const records: { context: NodeExecutionContext }[] = [];
  const execute = vi.fn(
    async (input: { value: string }, _config: unknown, context: NodeExecutionContext) => {
      records.push({ context });
      return { text: input.value };
    },
  );
  const registry = new NodeRegistry([
    createIfNodeType(),
    createIterationNodeType(),
    createSubworkflowNodeType(),
    {
      manifest: {
        type: 'test.echo',
        version: 1,
        executionKind: 'action',
        metadata: { name: '文本', category: 'data' },
        inputs: [{ key: 'value', name: '值', dataType: StringType, required: true }],
        outputs: [{ key: 'text', name: '文本', dataType: StringType }],
        config: [],
      },
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ text: z.string() }),
      configSchema: z.object({}),
      execute,
    },
    {
      manifest: {
        type: 'test.join',
        version: 1,
        executionKind: 'action',
        metadata: { name: '汇聚', category: 'data' },
        inputs: [
          { key: 'a', name: 'A', dataType: StringType, required: true },
          { key: 'b', name: 'B', dataType: StringType, required: true },
        ],
        outputs: [{ key: 'text', name: '文本', dataType: StringType }],
        config: [],
      },
      inputSchema: z.object({ a: z.string(), b: z.string() }),
      outputSchema: z.object({ text: z.string() }),
      configSchema: z.object({}),
      execute: async (input: { a: string; b: string }) => ({ text: `${input.a}|${input.b}` }),
    },
  ]);
  const nodeRuns = auditedNodeRunRepositoryFixture();
  const codec = new DefaultRuntimeValueCodec(
    { resolve: vi.fn().mockRejectedValue(new Error('不应读取引用')) },
    { write: vi.fn().mockRejectedValue(new Error('不应写大对象')) },
    new DefaultDataStoragePolicyResolver(),
  );
  const bindings = createBindingResolver();
  const executor = new DefaultNodeExecutor(registry, bindings, codec, nodeRuns);
  const run = {
    id: 'run',
    workflowId: 'workflow',
    workflowVersionId: 'version',
    projectId: 'project',
    threadId: 'thread',
    invocationKey: 'start',
    status: 'running' as const,
    inputs: {},
    createdAt: '2026-10-26T00:00:00.000Z',
  };
  const runIdentity = {
    workflowId: run.workflowId,
    workflowVersionId: run.workflowVersionId,
    workflowRunId: run.id,
    projectId: run.projectId,
  };
  const root: WorkflowState = {
    run: runIdentity,
    inputs: {},
    outputs: { same: { text: text('parent ambient') } },
    variables: { secret: text('not shared') },
    execution: {},
  };
  async function local(
    definition: GraphDefinition,
    scopeKey = 'child',
    sources: Record<string, RuntimeValue> = {},
    definitionLocation = location,
  ) {
    const plan = prepareGraphCompilation({
      definition,
      definitionLocation,
      registry,
      strategies: strategies(),
      boundary: { entry: true, completion: true },
    });
    const builder = new StateGraph<
      typeof WorkflowStateAnnotation.spec,
      WorkflowState,
      Partial<WorkflowState>,
      string
    >(WorkflowStateAnnotation);
    const entry = vi.fn(async () => ({}));
    const completion = vi.fn(
      async (_state: WorkflowState, _outputs: Record<string, RuntimeValue>) => ({}),
    );
    const outputError = vi.fn(async (_state: WorkflowState, error: unknown): Promise<never> => {
      throw error;
    });
    compileGraph({
      plan,
      registry,
      run,
      execution: {
        resolve: () => ({
          scopeKey,
          ...(scopeKey === 'root' ? {} : { childExecutionId: `execution-${scopeKey}` }),
        }),
      },
      runtime: { executor, services: { bindings, codec } },
      target: {
        addNode: (id, execute) => {
          builder.addNode(id, execute);
        },
        addBoundaryNode: (id, execute) => {
          builder.addNode(id, execute);
        },
        addEdge: (sources, target) => {
          builder.addEdge(sources, target);
        },
        addConditionalEdges: (id, route, paths) => {
          builder.addConditionalEdges(id, route, paths);
        },
      },
      entry: { name: 'entry', execute: entry },
      completion: { name: 'complete', execute: completion, onOutputError: outputError },
    });
    // 编译期间没有 runtime mapping / ambient State 读取；调用单独建立显式边界。
    const invocation = createLocalGraphInvocation({
      definition,
      definitionLocation,
      scopeKey,
      run: runIdentity,
      sources,
      mappings: definition.inputs
        .filter((input) => Object.hasOwn(sources, input.name))
        .map((input) => ({ source: input.name, target: input.name })),
    });
    const compiled = builder.compile().withConfig({ recursionLimit: plan.budget.recursionLimit });
    const result = await compiled.invoke(invocation.state);
    return { result, plan, completion, entry, outputError };
  }
  return { registry, nodeRuns, executor, execute, records, run, root, local };
}

describe('通用 scoped graph compilation', () => {
  it('局部 Action DAG、声明输出与同名 nodeId 不读取父 ambient State；同一位置可使用不同 scope', async () => {
    const f = fixture();
    const node = textNode('same');
    node.inputs.value = { type: 'workflow_input', key: 'value' };
    const definition = graph(
      [node],
      [],
      [{ name: 'result', type: StringType, source: { nodeId: 'same', outputKey: 'text' } }],
    );
    definition.inputs = [{ name: 'value', type: StringType, required: true }];
    const before = structuredClone(f.root);
    const parent = await f.local(
      definition,
      'root',
      { value: text('parent') },
      { workflowVersionId: 'version', path: [] },
    );
    const parentSnapshot = structuredClone(parent.result);
    const first = await f.local(definition, 'scope-A', { value: text('A') });
    const second = await f.local(definition, 'scope-B', { value: text('B') });
    expect(first.completion.mock.calls[0]![1]).toEqual({ result: text('A') });
    expect(second.completion.mock.calls[0]![1]).toEqual({ result: text('B') });
    expect(first.plan.definitionLocation).toEqual(second.plan.definitionLocation);
    expect(f.root).toEqual(before);
    expect(parent.result).toEqual(parentSnapshot);
    expect(
      f.records.every(({ context }) => Object.keys(context.state.variables).length === 0),
    ).toBe(true);
    expect(
      f.nodeRuns
        .getRecords()
        .map((row) => [row.nodeId, row.scopeKey, row.childExecutionId, row.attempt]),
    ).toEqual([
      ['same', 'root', undefined, 1],
      ['same', 'scope-A', 'execution-scope-A', 1],
      ['same', 'scope-B', 'execution-scope-B', 1],
    ]);
    expect(new Set(f.nodeRuns.getRecords().map((row) => row.occurrenceId)).size).toBe(3);
  });
  it('local parallel / ALL join 与 declared-output barrier 都只执行一次', async () => {
    const f = fixture();
    const join = { ...textNode('join'), type: 'test.join', inputs: {} };
    const definition = graph(
      [textNode('left', 'L'), textNode('right', 'R'), join],
      [
        {
          id: 'a',
          kind: 'data',
          source: { nodeId: 'left', portKey: 'text' },
          target: { nodeId: 'join', portKey: 'a' },
        },
        {
          id: 'b',
          kind: 'data',
          source: { nodeId: 'right', portKey: 'text' },
          target: { nodeId: 'join', portKey: 'b' },
        },
      ],
      [{ name: 'result', type: StringType, source: { nodeId: 'join', outputKey: 'text' } }],
    );
    const result = await f.local(definition);
    expect(result.completion).toHaveBeenCalledOnce();
    expect(result.entry).toHaveBeenCalledOnce();
    expect(result.completion.mock.calls[0]![1]).toEqual({ result: text('L|R') });
    expect(f.nodeRuns.getRecords()).toHaveLength(3);
    expect(
      f.nodeRuns.getRecords().every((row) => row.attempt === 1 && row.status === 'completed'),
    ).toBe(true);
  });
  it('多个并行叶节点先汇聚再解析声明输出', async () => {
    const f = fixture();
    const result = await f.local(
      graph(
        [textNode('left'), textNode('right')],
        [],
        [
          { name: 'a', type: StringType, source: { nodeId: 'left', outputKey: 'text' } },
          { name: 'b', type: StringType, source: { nodeId: 'right', outputKey: 'text' } },
        ],
      ),
    );
    expect(result.completion).toHaveBeenCalledOnce();
    expect(result.completion.mock.calls[0]![1]).toEqual({ a: text('left'), b: text('right') });
    expect(result.plan.budget.localRecursionLimit).toBe(4);
  });
  it('局部业务 nodeId 与入口/输出内部节点同名时仍各执行一次', async () => {
    const f = fixture();
    const result = await f.local(
      graph(
        [textNode('entry'), textNode('complete')],
        [],
        [
          { name: 'a', type: StringType, source: { nodeId: 'entry', outputKey: 'text' } },
          { name: 'b', type: StringType, source: { nodeId: 'complete', outputKey: 'text' } },
        ],
      ),
    );
    expect(result.entry).toHaveBeenCalledOnce();
    expect(result.completion).toHaveBeenCalledOnce();
    expect(
      f.nodeRuns
        .getRecords()
        .map((row) => row.nodeId)
        .sort(),
    ).toEqual(['complete', 'entry']);
  });
  it('local Template 的 node_output 依赖不需要伪造 DataEdge', async () => {
    const f = fixture();
    const consumer = textNode('consumer');
    consumer.inputs.value = {
      type: 'template',
      value: '{{upstream}}!',
      variables: { upstream: { type: 'node_output', nodeId: 'source', portKey: 'text' } },
    };
    const result = await f.local(
      graph(
        [consumer, textNode('source', 'hello')],
        [],
        [{ name: 'result', type: StringType, source: { nodeId: 'consumer', outputKey: 'text' } }],
      ),
    );
    expect(result.completion.mock.calls[0]![1]).toEqual({ result: text('hello!') });
    expect(f.nodeRuns.getRecords().map((row) => row.nodeId)).toEqual(['source', 'consumer']);
  });
  it.each(['yes', 'no'])(
    'local Candidate 复用正式 If 分发及 mutually-exclusive dependency proof：%s',
    async (value) => {
      const f = fixture();
      const candidate = textNode('merge');
      candidate.inputs.value = {
        type: 'candidate',
        sources: [
          { type: 'node_output', nodeId: 'yes', portKey: 'text' },
          { type: 'node_output', nodeId: 'no', portKey: 'text' },
        ],
      };
      const gate: NodeDefinition = {
        ...textNode('gate'),
        type: 'flow.if',
        config: { condition: { '===': [{ var: 'value' }, 'yes'] } },
      };
      gate.inputs.value = { type: 'workflow_input', key: 'value' };
      const definition = graph(
        [gate, textNode('yes'), textNode('no'), candidate],
        [
          {
            id: 'yes',
            kind: 'control',
            source: { nodeId: 'gate', portKey: 'true' },
            target: { nodeId: 'yes' },
          },
          {
            id: 'no',
            kind: 'control',
            source: { nodeId: 'gate', portKey: 'false' },
            target: { nodeId: 'no' },
          },
        ],
        [{ name: 'result', type: StringType, source: { nodeId: 'merge', outputKey: 'text' } }],
      );
      definition.inputs = [{ name: 'value', type: StringType, required: true }];
      const result = await f.local(definition, `scope-${value}`, { value: text(value) });
      expect(result.completion.mock.calls[0]![1]).toEqual({ result: text(value) });
      expect(f.nodeRuns.getRecords().map((row) => row.nodeId)).toEqual([value, 'merge']);
    },
  );
  it('输出解析失败交给调用方生命周期边界，不执行完成回调', async () => {
    const f = fixture();
    await expect(
      f.local(
        graph(
          [textNode('source')],
          [],
          [{ name: 'result', type: NumberType, source: { nodeId: 'source', outputKey: 'text' } }],
        ),
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_OUTPUT_TYPE_MISMATCH' });
  });
  it('局部空图入口与输出收口仍完整执行', async () => {
    const f = fixture();
    const result = await f.local(graph([]));
    expect(result.entry).toHaveBeenCalledOnce();
    expect(result.completion).toHaveBeenCalledOnce();
    expect(result.completion.mock.calls[0]![1]).toEqual({});
    expect(f.execute).not.toHaveBeenCalled();
  });
});

function iterationNode(id: string, body: GraphDefinition): NodeDefinition {
  return {
    ...textNode(id),
    type: 'flow.iteration',
    inputs: { items: { type: 'constant', value: [] } },
    composite: {
      kind: 'iteration',
      itemType: StringType,
      invariantInputs: [],
      bodyInputMapping: [],
      body,
    },
  };
}
describe('静态位置、递归预算与生产门禁', () => {
  it('沿已有 graph slots 形成 root / body / graph 静态路径，与 nodeId 全局唯一无关', () => {
    const root: GraphCompilationLocation = { workflowVersionId: 'version', path: [] };
    const sub: NodeDefinition = {
      ...textNode('same'),
      type: 'flow.subworkflow',
      composite: { kind: 'subworkflow', graph: graph([textNode('same')]) },
    };
    const iteration = iterationNode('same', graph([sub]));
    expect(childGraphDefinitionLocation(root, sub, 'graph').path).toEqual([
      { nodeId: 'same', graphKey: 'graph' },
    ]);
    const body = childGraphDefinitionLocation(root, iteration, 'body');
    expect(childGraphDefinitionLocation(body, sub, 'graph').path).toEqual([
      { nodeId: 'same', graphKey: 'body' },
      { nodeId: 'same', graphKey: 'graph' },
    ]);
    expect(() => childGraphDefinitionLocation(root, sub, 'body')).toThrow('槽位不存在');
  });
  it('递归技术预算取各原生图实际结构的最大值，不让分析结果解除 nested Iteration 门禁', () => {
    const f = fixture();
    const nodes = Array.from({ length: 80 }, (_, i) => textNode(`n${i}`));
    const leaf = graph(
      nodes,
      nodes.slice(1).map((node, i) => ({
        id: `e${i}`,
        kind: 'control' as const,
        source: { nodeId: `n${i}` },
        target: { nodeId: node.id },
      })),
    );
    const definition = graph([iterationNode('same', graph([iterationNode('same', leaf)]))]);
    const input = {
      definition,
      definitionLocation: { workflowVersionId: 'version', path: [] },
      registry: f.registry,
      strategies: strategies(),
    };
    const plan = analyzeGraphCompilation(input);
    expect(plan.budget.recursionLimit).toBe(83);
    expect(plan.children[0]!.plan.children[0]!.plan.budget.localRecursionLimit).toBe(83);
    expect(() => prepareGraphCompilation(input)).toThrow(
      expect.objectContaining({ code: 'ITERATION_BODY_CAPABILITY_UNSUPPORTED' }),
    );
  });
  it('同一 Body 的预算不随 0 / 1 / 100 个 item 改变', () => {
    const f = fixture();
    const limits = [0, 1, 100].map((count) => {
      const node = iterationNode('iteration', graph([textNode('action')]));
      node.inputs.items = { type: 'constant', value: Array.from({ length: count }, () => 'x') };
      return prepareGraphCompilation({
        definition: graph([node]),
        definitionLocation: { workflowVersionId: 'version', path: [] },
        registry: f.registry,
        strategies: strategies(),
      }).budget.recursionLimit;
    });
    expect(limits).toEqual([4, 4, 4]);
  });
  it('SubWorkflow 递归预算取子图 D+3 与 wrapper 4 的较大值', () => {
    const f = fixture();
    const child = graph(
      [textNode('a'), textNode('b')],
      [
        {
          id: 'next',
          kind: 'control',
          source: { nodeId: 'a' },
          target: { nodeId: 'b' },
        },
      ],
    );
    const node: NodeDefinition = {
      ...textNode('sub'),
      type: 'flow.subworkflow',
      inputs: {},
      composite: { kind: 'subworkflow', graph: child },
    };
    const plan = prepareGraphCompilation({
      definition: graph([node]),
      definitionLocation: { workflowVersionId: 'version', path: [] },
      registry: f.registry,
      strategies: strategies(),
    });
    expect(plan.children[0]!.plan.budget.localRecursionLimit).toBe(5);
    expect(plan.budget.recursionLimit).toBe(5);
  });
  it('子图 Candidate 在生产编译前拒绝，不进入 If 歧义分析', () => {
    const f = fixture();
    const merge = textNode('merge');
    merge.inputs.value = {
      type: 'candidate',
      sources: [
        { type: 'node_output', nodeId: 'yes', portKey: 'text' },
        { type: 'node_output', nodeId: 'no', portKey: 'text' },
      ],
    };
    const node: NodeDefinition = {
      ...textNode('sub'),
      type: 'flow.subworkflow',
      inputs: {},
      composite: {
        kind: 'subworkflow',
        graph: graph([textNode('yes'), textNode('no'), merge]),
      },
    };
    expect(() =>
      prepareGraphCompilation({
        definition: graph([node]),
        definitionLocation: { workflowVersionId: 'version', path: [] },
        registry: f.registry,
        strategies: strategies(),
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'SUBWORKFLOW_GRAPH_CANDIDATE_UNSUPPORTED',
        nodeId: 'merge',
        portKey: 'value',
        definitionPath: [{ nodeId: 'sub', graphKey: 'graph' }],
      }),
    );
  });
  it('子图 If 在创建执行服务前拒绝', async () => {
    const f = iterationRuntimeFixture(1);
    f.registry.register(createSubworkflowNodeType());
    f.registry.register(createIfNodeType());
    f.definition.nodes = [
      {
        ...textNode('sub'),
        type: 'flow.subworkflow',
        inputs: {},
        composite: {
          kind: 'subworkflow',
          graph: graph([
            {
              ...textNode('gate'),
              type: 'flow.if',
              inputs: {},
              config: {},
            },
          ]),
        },
      },
    ];
    f.definition.edges = [];
    f.definition.outputs = [];
    await expect(f.createCompiler().compile(f.definition, f.run)).rejects.toMatchObject({
      code: 'SUBWORKFLOW_GRAPH_CAPABILITY_UNSUPPORTED',
      nodeId: 'gate',
    });
    expect(f.createExecutor).not.toHaveBeenCalled();
  });
});
