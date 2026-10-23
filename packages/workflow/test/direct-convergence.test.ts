import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { StringType, type NodeDefinition, type WorkflowDefinition } from '@dramaflow/contracts';
import {
  createIfNodeType,
  createWorkflowDefinitionSnapshot,
  validateWorkflowForPublish,
  workflowStateSchema,
} from '../src/index.js';
import { analyzeSimpleIfExecution } from '../src/compiler/if/analysis.js';
import { DependencyCompiler } from '../src/compiler/dependency.compiler.js';
import { workflowRunnerFixture } from './workflow-runner-fixture.js';

afterEach(() => vi.restoreAllMocks());
function action(id: string): NodeDefinition {
  return {
    id,
    type: 'test.text',
    typeVersion: 1,
    name: id,
    inputs: { text: { type: 'constant', value: id } },
    config: {},
    ui: { position: { x: 0, y: 0 } },
  };
}
function edge(from: string, to: string): WorkflowDefinition['edges'][number] {
  return { id: `${from}-${to}`, kind: 'control', source: { nodeId: from }, target: { nodeId: to } };
}
function template(source: string): NodeDefinition['inputs'][string] {
  return {
    type: 'template',
    value: '{{v}}',
    variables: { v: { type: 'node_output', nodeId: source, portKey: 'text' } },
  };
}
function definition(choice = true): WorkflowDefinition {
  const a = action('A');
  a.inputs.text = { type: 'constant', value: choice ? 'hello' : 'no' };
  return {
    inputs: [],
    nodes: [
      a,
      {
        ...action('If'),
        type: 'flow.if',
        inputs: {},
        config: { condition: { in: ['hello', { var: 'value' }] } },
      },
      action('B'),
      action('C'),
      action('D'),
    ],
    edges: [
      {
        id: 'value',
        kind: 'data',
        source: { nodeId: 'A', portKey: 'text' },
        target: { nodeId: 'If', portKey: 'value' },
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
      edge('B', 'D'),
      edge('C', 'D'),
    ],
    outputs: [{ name: 'result', type: StringType, source: { nodeId: 'D', outputKey: 'text' } }],
  };
}
function fixture(d: WorkflowDefinition) {
  const f = workflowRunnerFixture();
  f.registry.register(createIfNodeType());
  const execute = vi.fn(async (input: { text: string }) => ({ text: input.text }));
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
    execute,
  });
  const finished: { id: string; step: unknown }[] = [];
  const original = f.executor.execute.bind(f.executor);
  vi.spyOn(f.executor, 'execute').mockImplementation(async (node, context) => {
    const value = await original(node, context);
    finished.push({ id: node.id, step: context.runnableConfig?.metadata?.langgraph_step });
    return value;
  });
  f.version.definition = createWorkflowDefinitionSnapshot(d);
  return {
    ...f,
    execute,
    finished,
    run: () => f.start({ ...f.input, inputs: {} }),
    state: () => f.graphs[0]!.getState({ configurable: { thread_id: 'thread-7' } }),
  };
}
function analysis(d: WorkflowDefinition) {
  return analyzeSimpleIfExecution(
    d,
    new Set(d.nodes.filter((n) => n.type === 'flow.if').map((n) => n.id)),
  );
}
function ids(f: ReturnType<typeof fixture>) {
  return f.finished.map((n) => n.id);
}

describe('direct convergence：生产 Compiler / Runner + 真实 LangGraph', () => {
  it.each([true, false])('simple %s：D 为 ordinary，只执行一次，无额外控制节点', async (choice) => {
    const d = definition(choice);
    const f = fixture(d);
    validateWorkflowForPublish(d, f.registry);
    const a = analysis(d);
    expect(a.convergences).toEqual([
      { ifNodeId: 'If', targetNodeId: 'D', completionGroups: { true: ['B'], false: ['C'] } },
    ]);
    expect(a.branchRegions.memberships.get('D')).toEqual([]);
    expect(a).toMatchObject({ roots: ['A'], leaves: ['D'], maxDepth: 4, recursionLimit: 5 });
    const addEdge = vi.fn();
    new DependencyCompiler().compile({
      edges: d.edges,
      dependencies: a.staticDependencies,
      addEdge,
    });
    expect(addEdge.mock.calls.filter(([, target]) => target === 'D')).toEqual([
      ['B', 'D'],
      ['C', 'D'],
    ]);
    expect(await f.run()).toMatchObject({
      status: 'completed',
      outputs: { result: { value: 'D' } },
    });
    expect(f.finished).toEqual([
      { id: 'A', step: 1 },
      { id: choice ? 'B' : 'C', step: 3 },
      { id: 'D', step: 4 },
    ]);
    const state = await f.state();
    expect(state.next).toEqual([]);
    expect(state.tasks).toEqual([]);
    expect(Object.keys(state.values.outputs).sort()).toEqual(['A', choice ? 'B' : 'C', 'D']);
    expect(f.nodeRuns.createRunning.mock.calls.map(([n]) => n.nodeId)).toEqual(ids(f));
  });
  it.each([true, false])(
    'parallel / 不等深 terminals %s：branch-local ALL 后 D 一次',
    async (choice) => {
      const d = definition(choice);
      d.nodes.push(...['T', 'U', 'V'].map(action));
      d.edges = d.edges.filter((e) => e.id !== 'B-D');
      d.edges.push(edge('B', 'T'), edge('B', 'U'), edge('U', 'V'), edge('T', 'D'), edge('V', 'D'));
      const f = fixture(d);
      expect(analysis(d).convergences[0]?.completionGroups).toEqual({
        true: ['T', 'V'],
        false: ['C'],
      });
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.execute.mockImplementation(async (input) => {
        if (input.text === 'V') await wait;
        return { text: input.text };
      });
      const running = f.run();
      try {
        if (choice) {
          await vi.waitFor(() => expect(ids(f)).toContain('T'));
          expect(ids(f)).not.toContain('D');
        }
        release();
        expect(await running).toMatchObject({ status: 'completed' });
        expect(ids(f).filter((id) => id === 'D')).toHaveLength(1);
        expect(ids(f).sort()).toEqual(choice ? ['A', 'B', 'D', 'T', 'U', 'V'] : ['A', 'C', 'D']);
      } finally {
        release();
        await running;
      }
    },
  );
  it.each([true, false])('uneven branch %s + 后继普通 ALL join', async (choice) => {
    const d = definition(choice);
    d.nodes.push(...['T', 'After', 'X', 'End'].map(action));
    d.edges = d.edges.filter((e) => e.id !== 'B-D');
    d.edges.push(
      edge('B', 'T'),
      edge('T', 'D'),
      edge('D', 'After'),
      edge('After', 'End'),
      edge('X', 'End'),
    );
    d.outputs = [
      { name: 'result', type: StringType, source: { nodeId: 'End', outputKey: 'text' } },
    ];
    const f = fixture(d);
    const a = analysis(d);
    expect(a.branchRegions.ordinaryNodeIds).toEqual(
      expect.arrayContaining(['D', 'After', 'End', 'X']),
    );
    expect(a.staticDependencies).toContainEqual({
      targetNodeId: 'End',
      sourceNodeIds: ['After', 'X'],
    });
    expect(await f.run()).toMatchObject({
      status: 'completed',
      outputs: { result: { value: 'End' } },
    });
    expect(ids(f).filter((id) => id === 'D')).toHaveLength(1);
    expect(ids(f).filter((id) => id === 'End')).toHaveLength(1);
    expect(f.finished.find((n) => n.id === 'D')?.step).toBe(choice ? 5 : 4);
  });
  it.each([true, false])('共同上游 X 被纳入每组：%s，早到/晚到均不独立激活 D', async (late) => {
    for (const choice of [true, false]) {
      const d = definition(choice);
      let source = 'X';
      d.nodes.push(action(source));
      if (late)
        for (let i = 1; i < 6; i++) {
          const next = `X${i}`;
          d.nodes.push(action(next));
          d.edges.push(edge(source, next));
          source = next;
        }
      d.edges.push(edge(source, 'D'));
      const f = fixture(d),
        a = analysis(d);
      expect(a.convergences[0]?.completionGroups).toEqual({
        true: ['B', source],
        false: ['C', source],
      });
      const addEdge = vi.fn();
      new DependencyCompiler().compile({
        edges: d.edges,
        dependencies: a.staticDependencies,
        addEdge,
      });
      expect(addEdge.mock.calls.filter(([, target]) => target === 'D')).toEqual([
        [['B', source], 'D'],
        [['C', source], 'D'],
      ]);
      expect(await f.run()).toMatchObject({ status: 'completed' });
      expect(ids(f).filter((id) => id === 'D')).toHaveLength(1);
      expect(f.finished.find((n) => n.id === 'D')?.step).toBe(late ? 7 : 4);
      vi.restoreAllMocks();
    }
  });
  it('ordinary DataEdge / Template 可给汇聚节点供值；重复依赖仍去重', async () => {
    for (const kind of ['data', 'template']) {
      const d = definition();
      const target = d.nodes.find((n) => n.id === 'D')!;
      if (kind === 'template') target.inputs.text = template('A');
      else {
        target.inputs = {};
        d.edges.push({
          id: 'a-d-data',
          kind: 'data',
          source: { nodeId: 'A', portKey: 'text' },
          target: { nodeId: 'D', portKey: 'text' },
        });
      }
      d.edges.push(edge('A', 'D'));
      const f = fixture(d);
      expect(analysis(d).convergences[0]?.completionGroups).toEqual({
        true: ['B', 'A'],
        false: ['C', 'A'],
      });
      expect(await f.run()).toMatchObject({
        status: 'completed',
        outputs: { result: { value: 'hello' } },
      });
      vi.restoreAllMocks();
    }
  });
  it.each([true, false])('分支内部 ALL join 不退化，选中 %s 路径', async (choice) => {
    const d = definition(choice);
    d.nodes.push(...['T', 'U', 'V'].map(action));
    d.edges = d.edges.filter((e) => e.id !== 'B-D');
    d.edges.push(edge('B', 'T'), edge('B', 'U'), edge('T', 'V'), edge('U', 'V'), edge('V', 'D'));
    const f = fixture(d);
    expect(analysis(d).staticDependencies).toContainEqual({
      targetNodeId: 'V',
      sourceNodeIds: ['T', 'U'],
    });
    expect(await f.run()).toMatchObject({ status: 'completed' });
    expect(ids(f).filter((id) => id === 'V')).toHaveLength(choice ? 1 : 0);
    expect(ids(f).filter((id) => id === 'D')).toHaveLength(1);
  });
  it.each([true, false])('深路径预算没有额外 Merge step：%s', async (choice) => {
    const d = definition(choice);
    d.edges = d.edges.filter((e) => e.id !== 'B-D');
    let previous = 'B';
    for (let i = 1; i < 100; i++) {
      const next = `T${i}`;
      d.nodes.push(action(next));
      d.edges.push(edge(previous, next));
      previous = next;
    }
    d.edges.push(edge(previous, 'D'));
    previous = 'D';
    for (let i = 1; i < 30; i++) {
      const next = `Post${i}`;
      d.nodes.push(action(next));
      d.edges.push(edge(previous, next));
      previous = next;
    }
    d.outputs = [
      { name: 'result', type: StringType, source: { nodeId: previous, outputKey: 'text' } },
    ];
    const f = fixture(d);
    expect(analysis(d)).toMatchObject({ maxDepth: 132, recursionLimit: 133 });
    expect(await f.run()).toMatchObject({ status: 'completed' });
    expect(f.finished.find((n) => n.id === previous)?.step).toBe(choice ? 132 : 33);
  });
  it.each(['data', 'template'])(
    '分支 %s successor 参与 membership 与汇聚 terminal 推导',
    async (kind) => {
      const d = definition();
      d.nodes.push(action('T'));
      d.edges = d.edges.filter((e) => e.id !== 'B-D');
      d.edges.push(edge('T', 'D'));
      const t = d.nodes.find((n) => n.id === 'T')!;
      if (kind === 'template') t.inputs.text = template('B');
      else {
        t.inputs = {};
        d.edges.push({
          id: 'b-t-data',
          kind: 'data',
          source: { nodeId: 'B', portKey: 'text' },
          target: { nodeId: 'T', portKey: 'text' },
        });
      }
      const f = fixture(d);
      expect(analysis(d).convergences[0]?.completionGroups).toEqual({ true: ['T'], false: ['C'] });
      expect(await f.run()).toMatchObject({ status: 'completed' });
      expect(ids(f)).toEqual(['A', 'B', 'T', 'D']);
    },
  );
  it('两个不同 If 不能在同一目标混成 alternatives', async () => {
    const d = definition();
    d.nodes.push(
      { ...d.nodes[1]!, id: 'If2', inputs: { value: { type: 'constant', value: 'hello' } } },
      action('X'),
      action('Y'),
    );
    d.edges.push(
      {
        id: 'true2',
        kind: 'control',
        source: { nodeId: 'If2', portKey: 'true' },
        target: { nodeId: 'X' },
      },
      {
        id: 'false2',
        kind: 'control',
        source: { nodeId: 'If2', portKey: 'false' },
        target: { nodeId: 'Y' },
      },
      edge('X', 'D'),
      edge('Y', 'D'),
    );
    const f = fixture(d);
    expect(() => validateWorkflowForPublish(d, f.registry)).toThrow(
      expect.objectContaining({ code: 'IF_REGION_INTERSECTION_UNSUPPORTED' }),
    );
    await expect(f.run()).rejects.toMatchObject({ code: 'IF_REGION_INTERSECTION_UNSUPPORTED' });
    expect(f.executorFactory).not.toHaveBeenCalled();
  });
  it('真实 recursion boundary：4 失败，5 完成', async () => {
    const f = fixture(definition());
    await f.run();
    const final = workflowStateSchema.parse((await f.state()).values),
      initial = { ...final, outputs: {}, execution: {} };
    await expect(
      f.graphs[0]!.invoke(initial, { configurable: { thread_id: 'low' }, recursionLimit: 4 }),
    ).rejects.toMatchObject({ name: 'GraphRecursionError' });
    await expect(
      f.graphs[0]!.invoke(initial, { configurable: { thread_id: 'enough' }, recursionLimit: 5 }),
    ).resolves.toBeDefined();
  });
  it.each(['data', 'template'])(
    '汇聚点单来源读取分支业务数据 %s：Publish / Compile 执行前拒绝',
    async (kind) => {
      const d = definition(),
        target = d.nodes.find((n) => n.id === 'D')!;
      if (kind === 'data') {
        target.inputs = {};
        d.edges.push({
          id: 'data-b-d',
          kind: 'data',
          source: { nodeId: 'B', portKey: 'text' },
          target: { nodeId: 'D', portKey: 'text' },
        });
      } else target.inputs.text = template('B');
      const f = fixture(d);
      expect(() => validateWorkflowForPublish(d, f.registry)).toThrow(
        expect.objectContaining({ code: 'IF_CONVERGENCE_INPUT_UNSUPPORTED', nodeId: 'D' }),
      );
      await expect(f.run()).rejects.toMatchObject({
        code: 'IF_CONVERGENCE_INPUT_UNSUPPORTED',
        nodeId: 'D',
      });
      expect(f.executorFactory).not.toHaveBeenCalled();
    },
  );
  it.each([
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ])(
    'candidate input convergence choice=%s, withControlEdges=%s：D 读取选中分支输出且只执行一次',
    async (choice, withControlEdges) => {
      const d = definition(choice);
      if (!withControlEdges) {
        d.edges = d.edges.filter((e) => e.id !== 'B-D' && e.id !== 'C-D');
      }
      d.nodes.find((n) => n.id === 'B')!.inputs.text = { type: 'constant', value: 'TRUE' };
      d.nodes.find((n) => n.id === 'C')!.inputs.text = { type: 'constant', value: 'FALSE' };
      d.nodes.find((n) => n.id === 'D')!.inputs.text = {
        type: 'candidate',
        sources: [
          { type: 'node_output', nodeId: 'B', portKey: 'text' },
          { type: 'node_output', nodeId: 'C', portKey: 'text' },
        ],
      };
      const f = fixture(d);
      validateWorkflowForPublish(d, f.registry);
      const a = analysis(d);
      expect(a.convergences).toEqual([
        { ifNodeId: 'If', targetNodeId: 'D', completionGroups: { true: ['B'], false: ['C'] } },
      ]);
      expect(a.branchRegions.memberships.get('D')).toEqual([]);
      expect(a).toMatchObject({ roots: ['A'], leaves: ['D'], maxDepth: 4, recursionLimit: 5 });
      const addEdge = vi.fn();
      new DependencyCompiler().compile({
        edges: d.edges,
        dependencies: a.staticDependencies,
        addEdge,
      });
      expect(addEdge.mock.calls.filter(([, target]) => target === 'D')).toEqual([
        ['B', 'D'],
        ['C', 'D'],
      ]);
      expect(await f.run()).toMatchObject({
        status: 'completed',
        outputs: { result: { value: choice ? 'TRUE' : 'FALSE' } },
      });
      expect(f.finished).toEqual([
        { id: 'A', step: 1 },
        { id: choice ? 'B' : 'C', step: 3 },
        { id: 'D', step: 4 },
      ]);
    },
  );
  it.each([true, false])(
    'candidate-only convergence + 普通依赖 X（choice=%s）：X 并入两组且等待选中分支与 X 均完成',
    async (choice) => {
      const d = definition(choice);
      d.edges = d.edges.filter((e) => e.id !== 'B-D' && e.id !== 'C-D');
      d.nodes.push(action('X1'), action('X2'), action('X'));
      d.edges.push(edge('X1', 'X2'), edge('X2', 'X'), edge('X', 'D'));
      d.nodes.find((n) => n.id === 'B')!.inputs.text = { type: 'constant', value: 'TRUE' };
      d.nodes.find((n) => n.id === 'C')!.inputs.text = { type: 'constant', value: 'FALSE' };
      d.nodes.find((n) => n.id === 'D')!.inputs.text = {
        type: 'candidate',
        sources: [
          { type: 'node_output', nodeId: 'B', portKey: 'text' },
          { type: 'node_output', nodeId: 'C', portKey: 'text' },
        ],
      };
      const f = fixture(d),
        a = analysis(d);
      expect(a.convergences[0]?.completionGroups).toEqual({
        true: ['X', 'B'],
        false: ['X', 'C'],
      });
      expect(a).toMatchObject({ maxDepth: 4, recursionLimit: 5 });
      const addEdge = vi.fn();
      new DependencyCompiler().compile({
        edges: d.edges,
        dependencies: a.staticDependencies,
        addEdge,
      });
      expect(addEdge.mock.calls.filter(([, target]) => target === 'D')).toEqual([
        [['X', 'B'], 'D'],
        [['X', 'C'], 'D'],
      ]);
      expect(await f.run()).toMatchObject({
        status: 'completed',
        outputs: { result: { value: choice ? 'TRUE' : 'FALSE' } },
      });
      expect(ids(f).filter((id) => id === 'D')).toHaveLength(1);
      expect(f.finished.find((n) => n.id === 'D')?.step).toBe(4);
    },
  );
  it.each([
    'same-branch',
    'ordinary-mixed',
    'different-if',
    'non-convergence-after',
    'non-convergence-plain',
    'three-sources',
  ] as const)('非法 candidate 拓扑 %s 在 Publish 与 Compile 前拒绝', async (kind) => {
    const d = definition();
    let expectedNodeId = 'D';
    if (kind === 'same-branch') {
      d.nodes.push(action('B2'));
      d.edges = d.edges.filter((e) => e.id !== 'B-D');
      d.edges.push(edge('B', 'B2'), edge('B2', 'D'));
      d.nodes.find((n) => n.id === 'D')!.inputs.text = {
        type: 'candidate',
        sources: [
          { type: 'node_output', nodeId: 'B', portKey: 'text' },
          { type: 'node_output', nodeId: 'B2', portKey: 'text' },
        ],
      };
    } else if (kind === 'ordinary-mixed') {
      d.nodes.find((n) => n.id === 'D')!.inputs.text = {
        type: 'candidate',
        sources: [
          { type: 'node_output', nodeId: 'A', portKey: 'text' },
          { type: 'node_output', nodeId: 'B', portKey: 'text' },
        ],
      };
    } else if (kind === 'different-if') {
      d.nodes.push(
        { ...d.nodes[1]!, id: 'If2', inputs: { value: { type: 'constant', value: 'hello' } } },
        action('X'),
        action('Y'),
      );
      d.edges.push(
        {
          id: 'true2',
          kind: 'control',
          source: { nodeId: 'If2', portKey: 'true' },
          target: { nodeId: 'X' },
        },
        {
          id: 'false2',
          kind: 'control',
          source: { nodeId: 'If2', portKey: 'false' },
          target: { nodeId: 'Y' },
        },
      );
      d.nodes.find((n) => n.id === 'D')!.inputs.text = {
        type: 'candidate',
        sources: [
          { type: 'node_output', nodeId: 'B', portKey: 'text' },
          { type: 'node_output', nodeId: 'X', portKey: 'text' },
        ],
      };
    } else if (kind === 'non-convergence-after') {
      expectedNodeId = 'After';
      d.nodes.push({
        ...action('After'),
        inputs: {
          text: {
            type: 'candidate',
            sources: [
              { type: 'node_output', nodeId: 'A', portKey: 'text' },
              { type: 'node_output', nodeId: 'D', portKey: 'text' },
            ],
          },
        },
      });
      d.outputs = [
        { name: 'result', type: StringType, source: { nodeId: 'After', outputKey: 'text' } },
      ];
    } else if (kind === 'non-convergence-plain') {
      expectedNodeId = 'Join';
      const plain: WorkflowDefinition = {
        inputs: [],
        nodes: [
          action('P1'),
          action('P2'),
          {
            ...action('Join'),
            inputs: {
              text: {
                type: 'candidate',
                sources: [
                  { type: 'node_output', nodeId: 'P1', portKey: 'text' },
                  { type: 'node_output', nodeId: 'P2', portKey: 'text' },
                ],
              },
            },
          },
        ],
        edges: [],
        outputs: [
          { name: 'result', type: StringType, source: { nodeId: 'Join', outputKey: 'text' } },
        ],
      };
      const f = fixture(plain);
      expect(() => validateWorkflowForPublish(plain, f.registry)).toThrow(
        expect.objectContaining({
          code: 'IF_CONVERGENCE_INPUT_UNSUPPORTED',
          nodeId: expectedNodeId,
        }),
      );
      await expect(f.run()).rejects.toMatchObject({
        code: 'IF_CONVERGENCE_INPUT_UNSUPPORTED',
        nodeId: expectedNodeId,
      });
      expect(f.executorFactory).not.toHaveBeenCalled();
      return;
    } else {
      d.nodes.push(action('B2'));
      d.edges = d.edges.filter((e) => e.id !== 'B-D');
      d.edges.push(edge('B', 'B2'), edge('B2', 'D'));
      d.nodes.find((n) => n.id === 'D')!.inputs.text = {
        type: 'candidate',
        sources: [
          { type: 'node_output', nodeId: 'B', portKey: 'text' },
          { type: 'node_output', nodeId: 'B2', portKey: 'text' },
          { type: 'node_output', nodeId: 'C', portKey: 'text' },
        ],
      };
    }
    const f = fixture(d);
    expect(() => validateWorkflowForPublish(d, f.registry)).toThrow(
      expect.objectContaining({ code: 'IF_CONVERGENCE_INPUT_UNSUPPORTED', nodeId: expectedNodeId }),
    );
    await expect(f.run()).rejects.toMatchObject({
      code: 'IF_CONVERGENCE_INPUT_UNSUPPORTED',
      nodeId: expectedNodeId,
    });
    expect(f.executorFactory).not.toHaveBeenCalled();
  });
  it.each(['entry', 'partial', 'multiple', 'bypass'])(
    '不安全 convergence %s 继续拒绝',
    async (kind) => {
      const d = definition();
      if (kind === 'entry') {
        d.edges = d.edges.filter((e) => e.id !== 'C-D');
        d.edges.push(edge('B', 'C'));
      }
      if (kind === 'partial') {
        d.nodes.push(action('Side'));
        d.edges.push(edge('C', 'Side'));
      }
      if (kind === 'multiple') {
        d.nodes.push(action('Other'));
        d.edges.push(edge('B', 'Other'), edge('C', 'Other'));
      }
      if (kind === 'bypass') {
        d.nodes.push(action('After'));
        d.edges.push(edge('D', 'After'), edge('B', 'After'));
      }
      const f = fixture(d);
      expect(() => validateWorkflowForPublish(d, f.registry)).toThrow();
      await expect(f.run()).rejects.toThrow();
      expect(f.executorFactory).not.toHaveBeenCalled();
    },
  );
  it('分支 output 单来源仍拒绝，候选来源继续安全；汇聚后单 source 已允许', async () => {
    const d = definition();
    d.outputs = [
      {
        name: 'result',
        type: StringType,
        sources: ['B', 'C'].map((nodeId) => ({ nodeId, outputKey: 'text' })),
      },
    ];
    const f = fixture(d);
    expect(await f.run()).toMatchObject({
      status: 'completed',
      outputs: { result: { value: 'B' } },
    });
    d.outputs = [{ name: 'result', type: StringType, source: { nodeId: 'B', outputKey: 'text' } }];
    expect(() => validateWorkflowForPublish(d, f.registry)).toThrow(
      expect.objectContaining({ code: 'CONDITIONAL_WORKFLOW_OUTPUT_UNSUPPORTED' }),
    );
  });
});
