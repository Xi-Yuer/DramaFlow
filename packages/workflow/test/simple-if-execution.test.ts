import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  StringType,
  type NodeDefinition,
  type WorkflowDefinition,
  type NodeOutputMap,
} from '@dramaflow/contracts';
import { z } from 'zod';
import { interrupt } from '@langchain/langgraph';
import {
  createIfNodeType,
  createWorkflowDefinitionSnapshot,
  validateWorkflowForPublish,
  workflowStateSchema,
  DefaultWorkflowOutputResolver,
} from '../src/index.js';
import * as condition from '../src/compiler/if/condition-evaluator.js';
import { analyzeSimpleIfExecution } from '../src/compiler/if/analysis.js';
import { workflowRunnerFixture } from './workflow-runner-fixture.js';

afterEach(() => vi.restoreAllMocks());
function action(id: string): NodeDefinition {
  return {
    id,
    type: 'test.text',
    typeVersion: 1,
    name: id,
    inputs: { text: { type: 'constant', value: 'approved' } },
    config: {},
    ui: { position: { x: 0, y: 0 } },
  };
}
function definition(): WorkflowDefinition {
  const gate: NodeDefinition = {
    id: 'If',
    type: 'flow.if',
    typeVersion: 1,
    name: '条件',
    inputs: {},
    config: { condition: { '===': [{ var: 'value' }, 'approved'] } },
    ui: { position: { x: 0, y: 0 } },
  };
  const b = action('B');
  b.inputs = {};
  const c = action('C');
  c.inputs = {
    text: {
      type: 'template',
      value: '{{source}}',
      variables: { source: { type: 'node_output', nodeId: 'A', portKey: 'text' } },
    },
  };
  return {
    inputs: [],
    nodes: [action('A'), gate, b, c],
    edges: [
      {
        id: 'a-if',
        kind: 'data',
        source: { nodeId: 'A', portKey: 'text' },
        target: { nodeId: 'If', portKey: 'value' },
      },
      {
        id: 'a-b',
        kind: 'data',
        source: { nodeId: 'A', portKey: 'text' },
        target: { nodeId: 'B', portKey: 'text' },
      },
      {
        id: 'true',
        kind: 'control',
        source: { nodeId: 'If', portKey: 'true' },
        target: { nodeId: 'B' },
      },
      {
        id: 'false',
        kind: 'control',
        source: { nodeId: 'If', portKey: 'false' },
        target: { nodeId: 'C' },
      },
    ],
    outputs: [{ name: 'result', type: StringType, source: { nodeId: 'A', outputKey: 'text' } }],
  };
}
function fixture(d = definition()) {
  const f = workflowRunnerFixture();
  f.registry.register(createIfNodeType());
  const actionExecute = vi.fn(async (input: { text: string }) => ({ text: input.text }));
  f.registry.register({
    manifest: {
      type: 'test.text',
      version: 1,
      executionKind: 'action',
      metadata: { name: '本地文本', category: 'data' },
      inputs: [{ key: 'text', name: '文本', dataType: StringType, required: true }],
      outputs: [{ key: 'text', name: '文本', dataType: StringType }],
      config: [],
    },
    inputSchema: z.object({ text: z.string() }).strict(),
    outputSchema: z.object({ text: z.string() }).strict(),
    configSchema: z.object({}).strict(),
    execute: actionExecute,
  });
  const executeNode = vi.spyOn(f.executor, 'execute');
  f.version.definition = createWorkflowDefinitionSnapshot(d);
  return { ...f, actionExecute, executeNode };
}
async function snapshot(f: ReturnType<typeof fixture>) {
  return f.graphs[0]!.getState({ configurable: { thread_id: 'thread-7' } });
}

function successorDefinition(): WorkflowDefinition {
  const d = definition();
  const next = action('D');
  next.inputs = {};
  const other = action('E');
  other.inputs = {
    text: {
      type: 'template',
      value: '{{c}}',
      variables: { c: { type: 'node_output', nodeId: 'C', portKey: 'text' } },
    },
  };
  d.nodes.push(next, other, action('F'), action('G'));
  d.edges.push(
    {
      id: 'bd',
      kind: 'data',
      source: { nodeId: 'B', portKey: 'text' },
      target: { nodeId: 'D', portKey: 'text' },
    },
    { id: 'ad', kind: 'control', source: { nodeId: 'A' }, target: { nodeId: 'D' } },
    { id: 'df', kind: 'control', source: { nodeId: 'D' }, target: { nodeId: 'F' } },
    { id: 'eg', kind: 'control', source: { nodeId: 'E' }, target: { nodeId: 'G' } },
  );
  d.outputs = [
    {
      name: 'result',
      type: StringType,
      sources: [
        { nodeId: 'D', outputKey: 'text' },
        { nodeId: 'E', outputKey: 'text' },
      ],
    },
  ];
  return d;
}

describe('真实 LangGraph Branch successor', () => {
  it.each([25, 50, 100])(
    '%i 层 branch successor 沿实际 execution graph 获得足够预算',
    async (depth) => {
      const d = definition();
      let parent = 'B';
      for (let index = 0; index < depth; index++) {
        const id = `next${index}`;
        d.nodes.push(action(id));
        d.edges.push({
          id: `edge${index}`,
          kind: 'control',
          source: { nodeId: parent },
          target: { nodeId: id },
        });
        parent = id;
      }
      d.outputs = [
        {
          name: 'result',
          type: StringType,
          sources: [
            { nodeId: parent, outputKey: 'text' },
            { nodeId: 'C', outputKey: 'text' },
          ],
        },
      ];
      const f = fixture(d);
      validateWorkflowForPublish(f.version.definition, f.registry);
      expect(analyzeSimpleIfExecution(d, new Set(['If']))).toMatchObject({
        maxDepth: depth + 3,
        recursionLimit: depth + 4,
      });
      expect(await f.start({ ...f.input, inputs: {} })).toMatchObject({ status: 'completed' });
      expect(f.executeNode).toHaveBeenCalledTimes(depth + 2);
    },
  );
  it.each([
    'control',
    'data',
    'template',
    'nested',
    'intersection',
    'outside',
    'single-output',
  ] as const)('非法 %s 在 Publish 和 Compiler 执行前以同一 code 拒绝', async (kind) => {
    const d = successorDefinition();
    let code = 'IF_CONVERGENCE_UNSUPPORTED';
    let nodeId = 'F';
    if (kind === 'nested') {
      code = 'IF_NESTED_UNSUPPORTED';
      nodeId = 'D';
      d.nodes[d.nodes.findIndex((node) => node.id === 'D')] = {
        ...structuredClone(d.nodes[1]!),
        id: 'D',
      };
      d.edges.find((edge) => edge.id === 'bd')!.target.portKey = 'value';
      d.edges = d.edges.filter((edge) => edge.id !== 'df');
      d.nodes.push(action('H'));
      d.edges.push(
        {
          id: 'nestedtrue',
          kind: 'control',
          source: { nodeId: 'D', portKey: 'true' },
          target: { nodeId: 'F' },
        },
        {
          id: 'nestedfalse',
          kind: 'control',
          source: { nodeId: 'D', portKey: 'false' },
          target: { nodeId: 'H' },
        },
      );
      d.outputs = [
        { name: 'result', type: StringType, source: { nodeId: 'A', outputKey: 'text' } },
      ];
    } else if (kind === 'intersection') {
      code = 'IF_REGION_INTERSECTION_UNSUPPORTED';
      nodeId = 'Z';
      d.nodes.push(
        {
          ...structuredClone(d.nodes[1]!),
          id: 'If2',
          inputs: { value: { type: 'constant', value: 'approved' } },
        },
        action('X'),
        action('Y'),
        action('Z'),
      );
      for (const [port, target] of [
        ['true', 'X'],
        ['false', 'Y'],
      ])
        d.edges.push({
          id: `if2${port}`,
          kind: 'control',
          source: { nodeId: 'If2', portKey: port },
          target: { nodeId: target! },
        });
      for (const source of ['B', 'X'])
        d.edges.push({
          id: `${source}Z`,
          kind: 'control',
          source: { nodeId: source },
          target: { nodeId: 'Z' },
        });
    } else if (kind === 'outside') {
      code = 'IF_BRANCH_DEPENDENCY_UNSUPPORTED';
      nodeId = 'D';
      d.nodes.push(action('X'));
      d.edges.push({ id: 'xd', kind: 'control', source: { nodeId: 'X' }, target: { nodeId: 'D' } });
    } else if (kind === 'single-output') {
      code = 'CONDITIONAL_WORKFLOW_OUTPUT_UNSUPPORTED';
      nodeId = 'F';
      d.outputs = [
        { name: 'result', type: StringType, source: { nodeId: 'F', outputKey: 'text' } },
      ];
    } else if (kind === 'template') {
      d.nodes.find((node) => node.id === 'F')!.inputs.text = {
        type: 'template',
        value: '{{c}}',
        variables: { c: { type: 'node_output', nodeId: 'C', portKey: 'text' } },
      };
    } else {
      if (kind === 'data') d.nodes.find((node) => node.id === 'F')!.inputs = {};
      d.edges.push(
        kind === 'data'
          ? {
              id: 'cf',
              kind: 'data',
              source: { nodeId: 'C', portKey: 'text' },
              target: { nodeId: 'F', portKey: 'text' },
            }
          : { id: 'cf', kind: 'control', source: { nodeId: 'C' }, target: { nodeId: 'F' } },
      );
    }
    const f = fixture(d);
    expect(() => validateWorkflowForPublish(f.version.definition, f.registry)).toThrow(
      expect.objectContaining({ code, nodeId }),
    );
    await expect(f.start({ ...f.input, inputs: {} })).rejects.toMatchObject({ code, nodeId });
    expect(f.executorFactory).not.toHaveBeenCalled();
    expect(f.nodeRuns.createRunning).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    '选中 %s region 才执行后继；Data/Template 传播且共同祖先不绕过 gate',
    async (choice) => {
      const d = successorDefinition();
      d.nodes[0]!.inputs.text = { type: 'constant', value: choice ? 'approved' : 'denied' };
      const f = fixture(d);
      validateWorkflowForPublish(f.version.definition, f.registry);
      const analysis = analyzeSimpleIfExecution(f.version.definition, new Set(['If']));
      expect(analysis.roots).toEqual(['A']);
      expect(analysis.leaves.sort()).toEqual(['F', 'G']);
      expect(analysis.staticDependencies).toContainEqual({
        targetNodeId: 'D',
        sourceNodeIds: ['B', 'A'],
      });
      expect(analysis).toMatchObject({ maxDepth: 5, recursionLimit: 6 });
      const result = await f.start({ ...f.input, inputs: {} });
      expect(result).toMatchObject({
        status: 'completed',
        outputs: { result: { value: choice ? 'approved' : 'denied' } },
      });
      const executed = f.executeNode.mock.calls.map(([node]) => node.id);
      expect(executed).toEqual(choice ? ['A', 'B', 'D', 'F'] : ['A', 'C', 'E', 'G']);
      expect(f.nodeRuns.createRunning.mock.calls.map(([input]) => input.nodeId)).toEqual(executed);
      expect((await snapshot(f)).next).toEqual([]);
    },
  );
  it.each([true, false])('候选可以取不同深度 B/E：%s', async (choice) => {
    const d = successorDefinition();
    d.nodes[0]!.inputs.text = { type: 'constant', value: choice ? 'approved' : 'denied' };
    d.outputs[0]!.sources![0]!.nodeId = 'B';
    const f = fixture(d);
    validateWorkflowForPublish(f.version.definition, f.registry);
    expect(await f.start({ ...f.input, inputs: {} })).toMatchObject({
      status: 'completed',
      outputs: { result: { value: choice ? 'approved' : 'denied' } },
    });
  });
  it.each([true, false])('分支内并行、不等长 ALL join 和多个 terminal：%s', async (choice) => {
    const d = definition();
    d.nodes[0]!.inputs.text = { type: 'constant', value: choice ? 'approved' : 'denied' };
    for (const id of ['D', 'E', 'H', 'F', 'T']) {
      const n = action(id);
      n.inputs.text = { type: 'constant', value: id };
      d.nodes.push(n);
    }
    for (const [source, target] of [
      ['B', 'D'],
      ['B', 'E'],
      ['E', 'H'],
      ['D', 'F'],
      ['H', 'F'],
      ['A', 'F'],
      ['B', 'T'],
    ])
      d.edges.push({
        id: `${source}${target}`,
        kind: 'control',
        source: { nodeId: source! },
        target: { nodeId: target! },
      });
    d.outputs = [
      {
        name: 'result',
        type: StringType,
        sources: [
          { nodeId: 'F', outputKey: 'text' },
          { nodeId: 'C', outputKey: 'text' },
        ],
      },
    ];
    const f = fixture(d);
    validateWorkflowForPublish(f.version.definition, f.registry);
    expect(analyzeSimpleIfExecution(d, new Set(['If']))).toMatchObject({
      maxDepth: 6,
      recursionLimit: 7,
    });
    expect(await f.start({ ...f.input, inputs: {} })).toMatchObject({
      status: 'completed',
      outputs: { result: { value: choice ? 'F' : 'denied' } },
    });
    const executed = f.executeNode.mock.calls.map(([node]) => node.id);
    expect(executed.filter((id) => id === 'F')).toHaveLength(choice ? 1 : 0);
    expect(executed.sort()).toEqual(choice ? ['A', 'B', 'D', 'E', 'F', 'H', 'T'] : ['A', 'C']);
    expect((await snapshot(f)).tasks).toEqual([]);
  });
});

describe('真实 LangGraph 简单 If 路由', () => {
  it.each(['missing', 'ambiguous', 'type'])(
    '最终 State 候选异常 %s 在 resolve_output 标记 failed',
    async (kind) => {
      const d = definition();
      d.outputs = [
        {
          name: 'result',
          type: StringType,
          sources: [
            { nodeId: 'B', outputKey: 'text' },
            { nodeId: 'C', outputKey: 'text' },
          ],
        },
      ];
      const f = fixture(d);
      f.resolve.mockImplementation((definition, state) => {
        const outputs: NodeOutputMap =
          kind === 'missing'
            ? {}
            : kind === 'ambiguous'
              ? {
                  B: { text: { storage: 'inline' as const, type: StringType, value: 'same' } },
                  C: { text: { storage: 'inline' as const, type: StringType, value: 'same' } },
                }
              : {
                  B: {
                    text: {
                      storage: 'inline' as const,
                      type: { kind: 'primitive' as const, name: 'number' as const },
                      value: 0,
                    },
                  },
                };
        return new DefaultWorkflowOutputResolver().resolve(definition, { ...state, outputs });
      });
      await expect(f.start({ ...f.input, inputs: {} })).rejects.toMatchObject({
        code:
          kind === 'missing'
            ? 'WORKFLOW_OUTPUT_MISSING'
            : kind === 'ambiguous'
              ? 'WORKFLOW_OUTPUT_AMBIGUOUS'
              : 'WORKFLOW_OUTPUT_TYPE_MISMATCH',
      });
      expect(f.runs.markFailed).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({
          stage: 'resolve_output',
          code: 'WORKFLOW_OUTPUT_RESOLUTION_FAILED',
        }),
      );
      expect(f.runs.markCompleted).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])('多候选最终输出：%s 只执行一支并持久化同名 result', async (choice) => {
    const d = definition();
    d.nodes[0]!.inputs.text = { type: 'constant', value: choice ? 'approved' : 'denied' };
    d.outputs = [
      {
        name: 'result',
        type: StringType,
        sources: [
          { nodeId: 'B', outputKey: 'text' },
          { nodeId: 'C', outputKey: 'text' },
        ],
      },
    ];
    const f = fixture(d);
    validateWorkflowForPublish(f.version.definition, f.registry);
    expect(await f.start({ ...f.input, inputs: {} })).toMatchObject({
      status: 'completed',
      outputs: { result: { storage: 'inline', value: choice ? 'approved' : 'denied' } },
    });
    expect(f.executeNode.mock.calls.map(([node]) => node.id)).toEqual(['A', choice ? 'B' : 'C']);
    expect(f.runs.markCompleted).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ result: expect.objectContaining({ storage: 'inline' }) }),
    );
  });
  it.each([true, false])(
    '条件 %s：只执行一支，DataEdge/Template 不绕过路由，不等待未选 leaf',
    async (choice) => {
      const d = definition();
      d.nodes[0]!.inputs.text = { type: 'constant', value: choice ? 'approved' : 'denied' };
      const f = fixture(d);
      const evaluate = vi.spyOn(condition, 'evaluateCondition');
      validateWorkflowForPublish(f.version.definition, f.registry);
      const result = await f.start({ ...f.input, inputs: {} });
      expect(result).toMatchObject({
        status: 'completed',
        outputs: { result: { value: choice ? 'approved' : 'denied' } },
      });
      expect(f.executeNode.mock.calls.map(([node]) => node.id)).toEqual(['A', choice ? 'B' : 'C']);
      expect(f.actionExecute).toHaveBeenCalledTimes(2);
      expect(f.nodeRuns.createRunning).toHaveBeenCalledTimes(2);
      expect(evaluate).toHaveBeenCalledTimes(1);
      const state = await snapshot(f);
      expect(state.next).toEqual([]);
      expect(state.tasks).toEqual([]);
      expect(state.values.execution).toEqual({ controlResults: { If: choice } });
      expect(Object.keys(state.values.outputs).sort()).toEqual(['A', choice ? 'B' : 'C']);
      expect(state.values.outputs.If).toBeUndefined();
      for (const [, context] of f.executeNode.mock.calls)
        expect(context.runnableConfig?.recursionLimit).toBe(4);
    },
  );
  it('原生 interrupt/resume 保留 If 结果，不重新计算或写入公开输出', async () => {
    const d = definition();
    d.nodes[2]!.inputs = { text: { type: 'constant', value: 'pause' } };
    d.edges = d.edges.filter((edge) => edge.id !== 'a-b');
    const f = fixture(d);
    f.actionExecute.mockImplementation(async (input) => {
      if (input.text === 'pause') interrupt('test-only interrupt');
      return { text: input.text };
    });
    const evaluate = vi.spyOn(condition, 'evaluateCondition');
    expect(await f.start({ ...f.input, inputs: {} })).toMatchObject({ status: 'waiting' });
    expect((await snapshot(f)).values.execution.controlResults).toEqual({ If: true });
    expect(await f.runner.executeResume({ workflowRunId: 'run-1', value: false })).toMatchObject({
      status: 'completed',
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(
      (await f.graphs[1]!.getState({ configurable: { thread_id: 'thread-7' } })).values.execution
        .controlResults,
    ).toEqual({ If: true });
    expect(f.executeNode.mock.calls.some(([node]) => node.id === 'C')).toBe(false);
  });
  it('真实 superstep 边界：A=1、If=2、leaf=3，limit=3 失败而 4 完成', async () => {
    const f = fixture();
    await f.start({ ...f.input, inputs: {} });
    const steps = f.executeNode.mock.calls.map(([node, context]) => [
      node.id,
      context.runnableConfig?.metadata?.langgraph_step,
    ]);
    expect(steps).toEqual([
      ['A', 1],
      ['B', 3],
    ]);
    const state = workflowStateSchema.parse((await snapshot(f)).values);
    const initial = { ...state, outputs: {}, execution: {} };
    await expect(
      f.graphs[0]!.invoke(initial, { configurable: { thread_id: 'limit-3' }, recursionLimit: 3 }),
    ).rejects.toMatchObject({ name: 'GraphRecursionError' });
    await expect(
      f.graphs[0]!.invoke(initial, { configurable: { thread_id: 'limit-4' }, recursionLimit: 4 }),
    ).resolves.toBeDefined();
  });
  it('100 个普通 root → If ALL → leaf，宽度不增加技术预算', async () => {
    const d = definition();
    for (let i = 0; i < 99; i++) {
      d.nodes.push(action(`root${i}`));
      d.edges.push({
        id: `root${i}`,
        kind: 'control',
        source: { nodeId: `root${i}` },
        target: { nodeId: 'If' },
      });
    }
    const f = fixture(d);
    expect(analyzeSimpleIfExecution(f.version.definition, new Set(['If']))).toMatchObject({
      maxDepth: 3,
      recursionLimit: 4,
    });
    expect(await f.start({ ...f.input, inputs: {} })).toMatchObject({ status: 'completed' });
    expect(f.executeNode).toHaveBeenCalledTimes(101);
  });
  it('If 复用 Binding/Codec，实际输入缺失或解码类型错误时不计算条件、不执行分支', async () => {
    for (const mode of ['missing', 'decode'] as const) {
      const f = fixture();
      const evaluate = vi.spyOn(condition, 'evaluateCondition');
      if (mode === 'missing') {
        const resolve = f.bindings.resolveInputs.bind(f.bindings);
        vi.spyOn(f.bindings, 'resolveInputs').mockImplementation(async (context) =>
          context.node.id === 'If' ? {} : resolve(context),
        );
      } else {
        const decode = f.codec.decodeRecord.bind(f.codec);
        vi.spyOn(f.codec, 'decodeRecord').mockImplementation(async (values, context) =>
          Object.hasOwn(values, 'value') ? { value: 0 } : decode(values, context),
        );
      }
      await expect(f.start({ ...f.input, inputs: {} })).rejects.toThrow();
      expect(evaluate).not.toHaveBeenCalled();
      expect(f.executeNode.mock.calls.map(([node]) => node.id)).toEqual(['A']);
      expect(f.runs.markFailed).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ stage: 'invoke' }),
      );
      vi.restoreAllMocks();
    }
  });
  it('If 无上游可作为 root，其他无条件 root 正常执行，最终 outputs 可为空', async () => {
    const d = definition();
    d.nodes[1]!.inputs.value = { type: 'constant', value: 'approved' };
    d.nodes[2]!.inputs = { text: { type: 'constant', value: 'B' } };
    d.nodes[3]!.inputs = { text: { type: 'constant', value: 'C' } };
    d.edges = d.edges.filter((edge) => edge.kind === 'control');
    d.outputs = [];
    const f = fixture(d);
    expect(analyzeSimpleIfExecution(d, new Set(['If'])).recursionLimit).toBe(3);
    expect(await f.start({ ...f.input, inputs: {} })).toMatchObject({
      status: 'completed',
      outputs: {},
    });
    expect(f.executeNode.mock.calls.map(([node]) => node.id).sort()).toEqual(['A', 'B']);
  });
  it('多个独立 If 在同一 superstep 写入内部结果，不覆盖且 false 能保留', async () => {
    const d = definition();
    const second = {
      ...structuredClone(d.nodes[1]!),
      id: 'If2',
      config: { condition: { '!==': [{ var: 'value' }, 'approved'] } },
    };
    d.nodes.push(second, action('D'), action('E'));
    d.edges.push(
      {
        id: 'a-if2',
        kind: 'data',
        source: { nodeId: 'A', portKey: 'text' },
        target: { nodeId: 'If2', portKey: 'value' },
      },
      {
        id: 'true2',
        kind: 'control',
        source: { nodeId: 'If2', portKey: 'true' },
        target: { nodeId: 'D' },
      },
      {
        id: 'false2',
        kind: 'control',
        source: { nodeId: 'If2', portKey: 'false' },
        target: { nodeId: 'E' },
      },
    );
    const f = fixture(d);
    const evaluate = vi.spyOn(condition, 'evaluateCondition');
    expect(await f.start({ ...f.input, inputs: {} })).toMatchObject({ status: 'completed' });
    expect(f.executeNode.mock.calls.map(([node]) => node.id).sort()).toEqual(['A', 'B', 'E']);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect((await snapshot(f)).values.execution.controlResults).toEqual({ If: true, If2: false });
  });
  it('If 等待多个普通上游 ALL，再用已就绪祖先为分支提供输入', async () => {
    const d = definition();
    d.nodes.push(action('X'));
    d.edges.push({
      id: 'x-if',
      kind: 'control',
      source: { nodeId: 'X' },
      target: { nodeId: 'If' },
    });
    const f = fixture(d);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.actionExecute.mockImplementation(async (input) => {
      if (input.text === 'slow') await wait;
      return { text: input.text };
    });
    d.nodes[4]!.inputs.text = { type: 'constant', value: 'slow' };
    f.version.definition = createWorkflowDefinitionSnapshot(d);
    const evaluate = vi.spyOn(condition, 'evaluateCondition');
    const running = f.start({ ...f.input, inputs: {} });
    try {
      await vi.waitFor(() => expect(f.actionExecute).toHaveBeenCalledTimes(2));
      expect(evaluate).not.toHaveBeenCalled();
      release();
      expect(await running).toMatchObject({ status: 'completed' });
      expect(evaluate).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await running;
    }
  });
  it.each([1, 24, 25, 30, 50, 100])(
    '%i 层上游 + If + leaf 的预算按实际 supersteps 推导',
    async (depth) => {
      const d = definition();
      for (let i = 1; i < depth; i++) {
        const node = action(`up${i}`);
        node.inputs = {};
        d.nodes.push(node);
        d.edges.push({
          id: `up${i}`,
          kind: 'data',
          source: { nodeId: i === 1 ? 'A' : `up${i - 1}`, portKey: 'text' },
          target: { nodeId: node.id, portKey: 'text' },
        });
      }
      d.edges[0]!.source.nodeId = depth === 1 ? 'A' : `up${depth - 1}`;
      const f = fixture(d);
      expect(analyzeSimpleIfExecution(f.version.definition, new Set(['If']))).toMatchObject({
        maxDepth: depth + 2,
        recursionLimit: depth + 3,
      });
      expect(await f.start({ ...f.input, inputs: {} })).toMatchObject({ status: 'completed' });
      expect(f.executeNode).toHaveBeenCalledTimes(depth + 1);
      for (const [, context] of f.executeNode.mock.calls)
        expect(context.runnableConfig?.recursionLimit).toBe(depth + 3);
    },
  );
  it('已移除的领域控制类型不能发布或编译，拒绝发生在创建执行服务前', async () => {
    const d = definition();
    d.nodes.push({ ...action('RemovedControl'), type: 'flow.merge', inputs: {} });
    const f = fixture(d);
    expect(f.registry.listManifests().map((manifest) => manifest.type)).not.toContain('flow.merge');
    expect(() => validateWorkflowForPublish(f.version.definition, f.registry)).toThrow(
      expect.objectContaining({ code: 'NODE_TYPE_UNAVAILABLE', nodeId: 'RemovedControl' }),
    );
    await expect(f.start({ ...f.input, inputs: {} })).rejects.toMatchObject({
      code: 'unavailable_type',
    });
    expect(f.executorFactory).not.toHaveBeenCalled();
    expect(f.nodeRuns.createRunning).not.toHaveBeenCalled();
  });
  it.each([
    'nested',
    'cross',
    'outside-input',
    'branch-output',
    'same-target',
    'multi-target',
    'unknown-port',
  ] as const)('%s 在 Publish 和 Compiler 执行节点前共同拒绝', async (kind) => {
    const d = definition();
    if (kind === 'branch-output') d.outputs[0]!.source!.nodeId = 'B';
    else if (kind === 'unknown-port') d.edges[2]!.source.portKey = 'maybe';
    else if (kind === 'same-target') d.edges[3]!.target.nodeId = 'B';
    else if (kind === 'multi-target')
      d.edges.push({
        id: 'extra',
        kind: 'control',
        source: { nodeId: 'If', portKey: 'true' },
        target: { nodeId: 'C' },
      });
    else if (kind === 'nested') {
      d.nodes[2] = {
        ...structuredClone(d.nodes[1]!),
        id: 'B',
        inputs: { value: { type: 'constant', value: 'approved' } },
      };
      d.edges = d.edges.filter((edge) => edge.id !== 'a-b');
      d.edges.push(
        {
          id: 'nested-true',
          kind: 'control',
          source: { nodeId: 'B', portKey: 'true' },
          target: { nodeId: 'C' },
        },
        {
          id: 'nested-false',
          kind: 'control',
          source: { nodeId: 'B', portKey: 'false' },
          target: { nodeId: 'A' },
        },
      );
      d.edges = d.edges.filter((edge) => edge.id !== 'a-if');
      d.nodes[1]!.inputs = { value: { type: 'constant', value: 'approved' } };
    } else if (kind === 'outside-input') {
      d.nodes.push(action('X'));
      d.edges[1]!.source.nodeId = 'X';
    } else {
      d.nodes.push(action('D'));
      d.edges.push({
        id: 'b-next',
        kind: 'control',
        source: { nodeId: 'B' },
        target: { nodeId: kind === 'cross' ? 'C' : 'D' },
      });
    }
    const f = fixture(d);
    expect(() => validateWorkflowForPublish(f.version.definition, f.registry)).toThrow();
    await expect(f.start({ ...f.input, inputs: {} })).rejects.toThrow();
    expect(f.executorFactory).not.toHaveBeenCalled();
    expect(f.actionExecute).not.toHaveBeenCalled();
    expect(f.nodeRuns.createRunning).not.toHaveBeenCalled();
  });
});
