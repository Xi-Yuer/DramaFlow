import { StringType, type NodeDefinition, type WorkflowDefinition } from '@dramaflow/contracts';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createWorkflowDefinitionSnapshot, validateWorkflowForPublish } from '../src/index.js';
import { analyzeActionDagExecution } from '../src/compiler/action-dag-execution-analysis.js';
import { workflowRunnerFixture } from './workflow-runner-fixture.js';

function fixture() {
  const f = workflowRunnerFixture();
  const execute = vi.fn(async () => ({ text: 'local' }));
  f.registry.register({
    manifest: {
      type: 'test.text',
      version: 1,
      executionKind: 'action',
      metadata: { name: '本地文本', category: 'data' },
      inputs: [
        { key: 'a', name: 'A', dataType: StringType },
        { key: 'b', name: 'B', dataType: StringType },
      ],
      outputs: [{ key: 'text', name: '文本', dataType: StringType }],
      config: [],
    },
    inputSchema: z.object({ a: z.string(), b: z.string() }),
    outputSchema: z.object({ text: z.string() }),
    configSchema: z.object({}).strict(),
    execute,
  });
  const executeNode = vi.spyOn(f.executor, 'execute');
  return { ...f, execute, executeNode };
}

function definition(count: number): WorkflowDefinition {
  return {
    inputs: [],
    outputs: [],
    edges: [],
    nodes: Array.from({ length: count }, (_, i): NodeDefinition => ({
      id: `n${i}`,
      type: 'test.text',
      typeVersion: 1,
      name: `节点 ${i}`,
      inputs: { a: { type: 'constant', value: 'a' }, b: { type: 'constant', value: 'b' } },
      config: {},
      ui: { position: { x: 0, y: 0 } },
    })),
  };
}

function connect(d: WorkflowDefinition, source: number, target: number) {
  d.edges.push({
    id: `${source}-${target}`,
    kind: 'control',
    source: { nodeId: `n${source}` },
    target: { nodeId: `n${target}` },
  });
}

async function complete(d: WorkflowDefinition, depth: number) {
  const f = fixture();
  const snapshot = createWorkflowDefinitionSnapshot(d);
  validateWorkflowForPublish(snapshot, f.registry);
  expect(analyzeActionDagExecution(snapshot)).toEqual({
    maxDepth: depth,
    recursionLimit: depth + 1,
  });
  f.version.definition = snapshot;
  expect(await f.start({ ...f.input, inputs: {} })).toMatchObject({ status: 'completed' });
  expect(f.execute).toHaveBeenCalledTimes(d.nodes.length);
  expect(f.nodeRuns.createRunning).toHaveBeenCalledTimes(d.nodes.length);
  expect(new Set(f.executeNode.mock.calls.map(([node]) => node.id)).size).toBe(d.nodes.length);
  for (const [, context] of f.executeNode.mock.calls) {
    expect(context.runnableConfig?.recursionLimit).toBe(depth + 1);
  }
  const state = await f.graphs[0]!.getState({ configurable: { thread_id: 'thread-7' } });
  expect(state.next).toEqual([]);
  expect(Object.keys(state.values.outputs)).toHaveLength(d.nodes.length);
}

describe('生产 Action DAG 的 LangGraph 执行预算', () => {
  it.each([0, 1, 24, 25, 30, 50, 100])('%i 层串行图完整执行', async (count) => {
    const d = definition(count);
    for (let i = 1; i < count; i++) connect(d, i - 1, i);
    await complete(d, count);
  });

  it('100 个独立节点只需要 2 的预算', async () => {
    await complete(definition(100), 1);
  });

  it('不等长 fan-out / join 按最长路径计算', async () => {
    const d = definition(7);
    for (const [source, target] of [
      [0, 1],
      [0, 2],
      [1, 3],
      [3, 4],
      [2, 5],
      [4, 5],
      [5, 6],
    ] as const)
      connect(d, source, target);
    await complete(d, 6);
  });

  it('仅 template node_output 依赖也形成 30 层路径', async () => {
    const d = definition(30);
    for (let i = 1; i < d.nodes.length; i++) {
      d.nodes[i]!.inputs.a = {
        type: 'template',
        value: '{{previous}}',
        variables: { previous: { type: 'node_output', nodeId: `n${i - 1}`, portKey: 'text' } },
      };
    }
    await complete(d, 30);
  });

  it('同一节点对的 Data / Control / Template 依赖去重', async () => {
    const d = definition(2);
    delete d.nodes[1]!.inputs.a;
    d.nodes[1]!.inputs.b = {
      type: 'template',
      value: '{{x}} {{y}}',
      variables: {
        x: { type: 'node_output', nodeId: 'n0', portKey: 'text' },
        y: { type: 'node_output', nodeId: 'n0', portKey: 'text' },
      },
    };
    connect(d, 0, 1);
    d.edges.push({
      id: 'data',
      kind: 'data',
      source: { nodeId: 'n0', portKey: 'text' },
      target: { nodeId: 'n1', portKey: 'a' },
    });
    await complete(d, 2);
  });

  it('分析与节点排列无关，不修改定义；workflow_input 不增加深度', async () => {
    const d = definition(3);
    d.inputs = [{ name: 'prompt', type: StringType, required: true }];
    d.nodes[0]!.inputs.a = {
      type: 'template',
      value: '{{prompt}}',
      variables: { prompt: { type: 'workflow_input', key: 'prompt' } },
    };
    connect(d, 0, 1);
    connect(d, 1, 2);
    d.nodes.reverse();
    const snapshot = createWorkflowDefinitionSnapshot(d);
    expect(analyzeActionDagExecution(snapshot)).toEqual({ maxDepth: 3, recursionLimit: 4 });
    expect(snapshot).toEqual(d);
  });

  it.each(['control', 'composite', 'interaction'] as const)(
    '拒绝 %s，且不创建 Executor',
    async (executionKind) => {
      const f = fixture();
      const { execute: _execute, ...declaration } = f.registry.get('test.text', 1);
      f.registry.register({
        ...declaration,
        manifest: { ...declaration.manifest, type: 'test.unsupported', executionKind },
      });
      const d = definition(2);
      d.nodes[1]!.type = 'test.unsupported';
      f.version.definition = d;
      await expect(f.start({ ...f.input, inputs: {} })).rejects.toMatchObject({
        code: 'NODE_EXECUTION_KIND_UNSUPPORTED',
        nodeId: d.nodes[1]!.id,
      });
      expect(f.executorFactory).not.toHaveBeenCalled();
      expect(f.executeNode).not.toHaveBeenCalled();
      expect(f.nodeRuns.createRunning).not.toHaveBeenCalled();
    },
  );

  it.each(['cycle', 'missing', 'version'] as const)(
    '无效定义 %s 在创建 Executor 前失败',
    async (kind) => {
      const f = fixture();
      const d = definition(2);
      if (kind === 'version') d.nodes[1]!.typeVersion = 999;
      else {
        connect(d, 0, 1);
        connect(d, kind === 'cycle' ? 1 : 99, 0);
      }
      f.version.definition = d;
      await expect(f.start({ ...f.input, inputs: {} })).rejects.toThrow();
      expect(f.executorFactory).not.toHaveBeenCalled();
      expect(f.executeNode).not.toHaveBeenCalled();
    },
  );

  it('纯分析拒绝环与悬空依赖，不返回不够用的预算', () => {
    const cycle = definition(2);
    connect(cycle, 0, 1);
    connect(cycle, 1, 0);
    expect(() => analyzeActionDagExecution(cycle)).toThrow('无环');
    const missing = definition(1);
    connect(missing, 99, 0);
    expect(() => analyzeActionDagExecution(missing)).toThrow('来源不存在');
    const missingTarget = definition(1);
    connect(missingTarget, 0, 99);
    expect(() => analyzeActionDagExecution(missingTarget)).toThrow('目标不存在');
  });
});
