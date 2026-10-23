import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import { StringType, type NodeDefinition, type WorkflowDefinition } from '@dramaflow/contracts';
import {
  createHumanReviewNodeType,
  createIfNodeType,
  createWorkflowDefinitionSnapshot,
  validateWorkflowForPublish,
  workflowStateSchema,
} from '../src/index.js';
import { analyzeStaticDagExecution } from '../src/compiler/action-dag-execution-analysis.js';
import { analyzeSimpleIfExecution } from '../src/compiler/if/analysis.js';
import { workflowRunnerFixture } from './workflow-runner-fixture.js';

afterEach(() => vi.restoreAllMocks());
const text = '  原文\n第二行\r\n  ';
const inline = (value: string) => ({ storage: 'inline' as const, type: StringType, value });
function node(id: string, review = false): NodeDefinition {
  return {
    id,
    type: review ? 'flow.human_review' : 'test.text',
    typeVersion: 1,
    name: id,
    inputs: { [review ? 'content' : 'text']: { type: 'constant', value: text } },
    config: review ? { instruction: '请核对人物设定' } : {},
    ui: { position: { x: 0, y: 0 } },
  };
}
function data(source: string, target: string, targetPort = 'content', sourcePort = 'text') {
  return {
    id: `${source}-${sourcePort}-${target}-${targetPort}`,
    kind: 'data' as const,
    source: { nodeId: source, portKey: sourcePort },
    target: { nodeId: target, portKey: targetPort },
  };
}
function serial(two = false): WorkflowDefinition {
  const nodes = [node('A'), node('R1', true), node('B')];
  const edges = [data('A', 'R1'), data('R1', 'B', 'text', 'content')];
  if (two) {
    nodes.push(node('R2', true), node('C'));
    edges.push(data('B', 'R2'), data('R2', 'C', 'text', 'content'));
  }
  for (const n of nodes.slice(1)) n.inputs = {};
  return {
    inputs: [],
    nodes,
    edges,
    outputs: [
      { name: 'result', type: StringType, source: { nodeId: two ? 'C' : 'B', outputKey: 'text' } },
    ],
  };
}
function fixture(d: WorkflowDefinition = serial()) {
  const f = workflowRunnerFixture();
  f.registry.register(createHumanReviewNodeType());
  f.registry.register(createIfNodeType());
  const executeText = vi.fn(async (input: { text: string }) => ({ text: input.text }));
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
    execute: executeText,
  });
  f.version.definition = createWorkflowDefinitionSnapshot(d);
  const executeNode = vi.spyOn(f.executor, 'execute');
  const resolveInputs = vi.spyOn(f.bindings, 'resolveInputs');
  return { ...f, executeText, executeNode, resolveInputs };
}
const config = { configurable: { thread_id: 'thread-7' } };
async function state(f: ReturnType<typeof fixture>) {
  const snapshot = await f.graphs.at(-1)!.getState(config);
  return {
    snapshot,
    state: workflowStateSchema.parse(snapshot.values),
    interrupts: snapshot.tasks.flatMap((task) => task.interrupts),
  };
}
async function start(f: ReturnType<typeof fixture>) {
  return f.start({ ...f.input, inputs: {} });
}
async function resume(f: ReturnType<typeof fixture>, value: unknown) {
  return f.runner.executeResume({ workflowRunId: 'run-1', value });
}

describe('生产 Human Review 专用策略 / 原生 interrupt', () => {
  it('review-only 可发布执行；只创建值服务，不创建 Action Executor 或 NodeRun', async () => {
    const d: WorkflowDefinition = { inputs: [], nodes: [node('R', true)], edges: [], outputs: [] };
    const f = fixture(d);
    expect(validateWorkflowForPublish(f.version.definition, f.registry)).toHaveLength(1);
    expect(await start(f)).toMatchObject({ status: 'waiting' });
    const waiting = await state(f);
    expect(waiting.state.outputs).toEqual({});
    expect(waiting.interrupts).toHaveLength(1);
    expect(waiting.interrupts[0]).toEqual({
      id: expect.any(String),
      value: {
        kind: 'human_review',
        schemaVersion: 1,
        nodeId: 'R',
        content: inline(text),
        instruction: '请核对人物设定',
      },
    });
    expect(JSON.parse(JSON.stringify(waiting.interrupts[0]!.value))).toEqual(
      waiting.interrupts[0]!.value,
    );
    expect(f.executorFactory).not.toHaveBeenCalled();
    expect(f.nodeRuns.createRunning).not.toHaveBeenCalled();
    expect(await resume(f, { action: 'approve' })).toMatchObject({ status: 'completed' });
    expect((await state(f)).state.outputs.R).toEqual({
      content: inline(text),
      action: inline('approve'),
      feedback: inline(''),
    });
    expect(f.executorFactory).not.toHaveBeenCalled();
    expect(f.nodeRuns.createRunning).not.toHaveBeenCalled();
  });
  it.each([
    { action: 'approve' },
    { action: 'reject' },
    { action: 'reject', feedback: '角色服装需要调整' },
  ])('%j 恢复为正常结果，上游不重跑且下游只在恢复后执行', async (decision) => {
    const f = fixture();
    validateWorkflowForPublish(f.version.definition, f.registry);
    const waiting = await start(f);
    expect(waiting).toMatchObject({
      status: 'waiting',
      threadId: 'thread-7',
    });
    expect(f.executeNode.mock.calls.map(([n]) => n.id)).toEqual(['A']);
    expect((await state(f)).state.outputs.R1).toBeUndefined();
    const waitingRun = await f.runs.getById('run-1');
    const completed = await resume(f, decision);
    expect(completed).toMatchObject({
      status: 'completed',
      threadId: 'thread-7',
      outputs: { result: inline(text) },
    });
    expect(await f.runs.getById('run-1')).toMatchObject({
      workflowVersionId: 'version-3',
      startedAt: waitingRun!.startedAt,
      threadId: 'thread-7',
    });
    expect((await state(f)).state.outputs.R1).toEqual({
      content: inline(text),
      action: inline(decision.action),
      feedback: inline(decision.feedback ?? ''),
    });
    expect(f.executeNode.mock.calls.map(([n]) => n.id)).toEqual(['A', 'B']);
    expect(f.nodeRuns.createRunning.mock.calls.map(([request]) => request.nodeId)).toEqual([
      'A',
      'B',
    ]);
    expect(f.resolveInputs.mock.calls.filter(([c]) => c.node.id === 'R1')).toHaveLength(2);
    expect(f.nodeRuns.markFailed).not.toHaveBeenCalled();
    expect(f.runs.markFailed).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { action: 'comment' },
    { action: 'reject', feedback: 2 },
    { action: 'approve', approved: true },
  ])('非法 decision %j 作为 execute 阶段节点错误，不输出或执行下游', async (decision) => {
    const f = fixture();
    await start(f);
    await expect(resume(f, decision)).rejects.toMatchObject({
      name: 'NodeExecutionError',
      nodeId: 'R1',
      stage: 'execute',
      code: 'NODE_EXECUTION_FAILED',
    });
    expect(await f.runs.getById('run-1')).toMatchObject({ status: 'failed' });
    expect(f.executeNode.mock.calls.map(([n]) => n.id)).toEqual(['A']);
    expect((await state(f)).state.outputs.R1).toBeUndefined();
    expect(f.nodeRuns.createRunning).toHaveBeenCalledTimes(1);
  });
  it('reference content 在 decode 前拒绝，不 materialize Artifact', async () => {
    const d: WorkflowDefinition = {
      inputs: [{ name: 'content', type: StringType, required: true }],
      nodes: [node('R', true)],
      edges: [],
      outputs: [],
    };
    d.nodes[0]!.inputs.content = { type: 'workflow_input', key: 'content' };
    const f = fixture(d);
    const decode = vi.spyOn(f.codec, 'decodeRecord');
    await expect(
      f.start({
        ...f.input,
        inputs: {
          content: {
            storage: 'reference',
            type: StringType,
            reference: { kind: 'artifact', id: 'artifact-1' },
          },
        },
      }),
    ).rejects.toMatchObject({ nodeId: 'R', stage: 'decode_input' });
    expect(decode).not.toHaveBeenCalled();
    expect(f.nodeRuns.createRunning).not.toHaveBeenCalled();
    expect(f.runs.markWaiting).not.toHaveBeenCalled();
  });
  it('Template node_output 正常解析为审核文本，resume 后复用原内容', async () => {
    const d = serial();
    d.edges = d.edges.filter((e) => e.target.nodeId !== 'R1');
    d.nodes[1]!.inputs.content = {
      type: 'template',
      value: '审核：{{text}}',
      variables: { text: { type: 'node_output', nodeId: 'A', portKey: 'text' } },
    };
    const f = fixture(d);
    validateWorkflowForPublish(f.version.definition, f.registry);
    await start(f);
    expect((await state(f)).interrupts[0]!.value).toMatchObject({
      content: inline(`审核：${text}`),
    });
    expect(await resume(f, { action: 'approve' })).toMatchObject({
      status: 'completed',
      outputs: { result: inline(`审核：${text}`) },
    });
    expect(f.executeNode.mock.calls.map(([n]) => n.id)).toEqual(['A', 'B']);
  });
  it('解码结果不符合文本 input schema 时按 validate_input 失败，不发出 interrupt', async () => {
    const f = fixture({ inputs: [], nodes: [node('R', true)], edges: [], outputs: [] });
    vi.spyOn(f.codec, 'decodeRecord').mockResolvedValue({ content: 42 });
    await expect(start(f)).rejects.toMatchObject({
      nodeId: 'R',
      stage: 'validate_input',
      code: 'NODE_INPUT_VALIDATION_FAILED',
    });
    expect(f.runs.markWaiting).not.toHaveBeenCalled();
    expect(f.nodeRuns.createRunning).not.toHaveBeenCalled();
  });
  it('串行两次 waiting/resume；原生 interrupt 独立，decision 保留且动作各执行一次', async () => {
    const f = fixture(serial(true));
    // 仓储测试替身记录生产 waitingRevision 的递增语义；不修改 Runner/HTTP 协议。
    let waitingRevision = 0;
    const markWaiting = f.runs.markWaiting.getMockImplementation()!;
    f.runs.markWaiting.mockImplementation(async (...args) => {
      await markWaiting(...args);
      waitingRevision++;
    });
    validateWorkflowForPublish(f.version.definition, f.registry);
    expect(await start(f)).toMatchObject({ status: 'waiting' });
    expect(waitingRevision).toBe(1);
    const first = await state(f);
    expect(first.interrupts[0]!.value).toMatchObject({ nodeId: 'R1' });
    expect(await resume(f, { action: 'approve', feedback: '第一轮通过' })).toMatchObject({
      status: 'waiting',
    });
    expect(waitingRevision).toBe(2);
    const second = await state(f);
    expect(second.interrupts[0]!.value).toMatchObject({ nodeId: 'R2' });
    expect(second.interrupts[0]!.id).not.toBe(first.interrupts[0]!.id);
    expect(second.state.outputs.R1).toEqual({
      content: inline(text),
      action: inline('approve'),
      feedback: inline('第一轮通过'),
    });
    expect(second.state.outputs.R2).toBeUndefined();
    expect(f.executeNode.mock.calls.map(([n]) => n.id)).toEqual(['A', 'B']);
    expect(await resume(f, { action: 'reject', feedback: '第二轮修改' })).toMatchObject({
      status: 'completed',
    });
    const final = await state(f);
    expect(final.state.outputs.R1).toEqual(second.state.outputs.R1);
    expect(final.state.outputs.R2).toEqual({
      content: inline(text),
      action: inline('reject'),
      feedback: inline('第二轮修改'),
    });
    expect(final.interrupts).toEqual([]);
    expect(f.executeNode.mock.calls.map(([n]) => n.id)).toEqual(['A', 'B', 'C']);
    expect(f.nodeRuns.createRunning.mock.calls.map(([n]) => n.nodeId)).toEqual(['A', 'B', 'C']);
    expect(f.runs.markWaiting).toHaveBeenCalledTimes(2);
  });
});

function reviewIf(): WorkflowDefinition {
  const d = serial();
  d.nodes.pop();
  d.edges.pop();
  d.nodes.push(
    {
      ...node('If'),
      type: 'flow.if',
      inputs: {},
      config: { condition: { '===': [{ var: 'value' }, 'approve'] } },
    },
    node('Yes'),
    node('No'),
  );
  d.edges.push(data('R1', 'If', 'value', 'action'));
  for (const [port, id] of [
    ['true', 'Yes'],
    ['false', 'No'],
  ] as const)
    d.edges.push({
      id: port,
      kind: 'control',
      source: { nodeId: 'If', portKey: port },
      target: { nodeId: id },
    });
  d.nodes.find((n) => n.id === 'Yes')!.inputs.text = { type: 'constant', value: '通过分支' };
  d.nodes.find((n) => n.id === 'No')!.inputs.text = { type: 'constant', value: '拒绝分支' };
  d.outputs = [
    {
      name: 'result',
      type: StringType,
      sources: [
        { nodeId: 'Yes', outputKey: 'text' },
        { nodeId: 'No', outputKey: 'text' },
      ],
    },
  ];
  return d;
}
describe('Human Review 与 If / capability / recursion budget', () => {
  it.each(['approve', 'reject'])('%s action 数据交给 If 独立控制分支', async (action) => {
    const f = fixture(reviewIf());
    validateWorkflowForPublish(f.version.definition, f.registry);
    expect(analyzeSimpleIfExecution(f.version.definition, new Set(['If']))).toMatchObject({
      maxDepth: 4,
      recursionLimit: 5,
    });
    await start(f);
    expect((await state(f)).state.execution).toEqual({});
    expect(await resume(f, { action })).toMatchObject({
      status: 'completed',
      outputs: { result: inline(action === 'approve' ? '通过分支' : '拒绝分支') },
    });
    const final = await state(f);
    expect(final.state.execution.controlResults).toEqual({ If: action === 'approve' });
    expect(f.executeNode.mock.calls.map(([n]) => n.id)).toEqual([
      'A',
      action === 'approve' ? 'Yes' : 'No',
    ]);
  });
  it.each(['branch', 'parallel', 'fanout'] as const)(
    '%s 拓扑在 Publish / Compile 创建服务前明确拒绝',
    async (mode) => {
      let d: WorkflowDefinition;
      if (mode === 'branch') {
        d = reviewIf();
        const yes = d.nodes.find((n) => n.id === 'Yes')!;
        Object.assign(yes, node('Yes', true));
        d.outputs = [];
      } else {
        d = { inputs: [], nodes: [node('R1', true), node('R2', true)], edges: [], outputs: [] };
        if (mode === 'fanout') {
          d.nodes.unshift(node('A'));
          d.nodes[1]!.inputs = {};
          d.nodes[2]!.inputs = {};
          d.edges = [data('A', 'R1'), data('A', 'R2')];
        }
      }
      const f = fixture(d);
      expect(() => validateWorkflowForPublish(f.version.definition, f.registry)).toThrow(
        expect.objectContaining({ code: 'HUMAN_REVIEW_TOPOLOGY_UNSUPPORTED' }),
      );
      await expect(start(f)).rejects.toMatchObject({ code: 'HUMAN_REVIEW_TOPOLOGY_UNSUPPORTED' });
      expect(f.executorFactory).not.toHaveBeenCalled();
      expect(f.resolveInputs).not.toHaveBeenCalled();
      expect(f.nodeRuns.createRunning).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])(
    'If direct convergence candidate → Review 在 region 外安全暂停恢复 %s',
    async (choice) => {
      const d = reviewIf();
      d.nodes = d.nodes.filter((n) => n.id !== 'R1');
      d.edges = d.edges.filter((e) => e.source.nodeId !== 'R1' && e.target.nodeId !== 'R1');
      d.nodes.find((n) => n.id === 'If')!.inputs.value = {
        type: 'constant',
        value: choice ? 'approve' : 'reject',
      };
      const r = node('R', true);
      r.inputs.content = {
        type: 'candidate',
        sources: ['Yes', 'No'].map((nodeId) => ({ type: 'node_output', nodeId, portKey: 'text' })),
      };
      d.nodes.push(r);
      d.outputs = [
        { name: 'result', type: StringType, source: { nodeId: 'R', outputKey: 'content' } },
      ];
      // A 是 If 的普通祖先，未增加分支到 Review 的 ControlEdge。
      d.edges.push({
        id: 'a-if',
        kind: 'control',
        source: { nodeId: 'A' },
        target: { nodeId: 'If' },
      });
      const f = fixture(d);
      validateWorkflowForPublish(f.version.definition, f.registry);
      expect(await start(f)).toMatchObject({ status: 'waiting' });
      const waiting = await state(f);
      expect(waiting.interrupts[0]!.value).toMatchObject({
        nodeId: 'R',
        content: inline(choice ? '通过分支' : '拒绝分支'),
      });
      expect(await resume(f, { action: 'approve' })).toMatchObject({
        status: 'completed',
        outputs: { result: inline(choice ? '通过分支' : '拒绝分支') },
      });
      expect(f.executeNode.mock.calls.map(([n]) => n.id)).toEqual(['A', choice ? 'Yes' : 'No']);
    },
  );
  it('30 层上游 → Review → 30 层后继：初次调用和恢复均使用已证明的图预算', async () => {
    const d: WorkflowDefinition = { inputs: [], nodes: [], edges: [], outputs: [] };
    for (let i = 0; i < 61; i++) {
      const id = i === 30 ? 'R' : `N${i}`;
      d.nodes.push(node(id, i === 30));
      if (i > 0)
        d.edges.push({
          id: `edge${i}`,
          kind: 'control',
          source: { nodeId: i === 31 ? 'R' : `N${i - 1}` },
          target: { nodeId: id },
        });
    }
    const f = fixture(d);
    validateWorkflowForPublish(f.version.definition, f.registry);
    expect(analyzeStaticDagExecution(d)).toEqual({ maxDepth: 61, recursionLimit: 62 });
    expect(await start(f)).toMatchObject({ status: 'waiting' });
    expect(f.executeNode).toHaveBeenCalledTimes(30);
    expect(await resume(f, { action: 'approve' })).toMatchObject({ status: 'completed' });
    expect(f.executeNode).toHaveBeenCalledTimes(60);
    expect(new Set(f.executeNode.mock.calls.map(([n]) => n.id)).size).toBe(60);
    for (const [, context] of f.executeNode.mock.calls)
      expect(context.runnableConfig?.recursionLimit).toBe(62);
  });
  it.each([0, 1, 2, 30])('Review root + %i 层后继：真实 resume superstep 边界', async (depth) => {
    const d: WorkflowDefinition = { inputs: [], nodes: [node('R', true)], edges: [], outputs: [] };
    for (let i = 0; i < depth; i++) {
      d.nodes.push(node(`N${i}`));
      d.edges.push({
        id: `e${i}`,
        kind: 'control',
        source: { nodeId: i ? `N${i - 1}` : 'R' },
        target: { nodeId: `N${i}` },
      });
    }
    const f = fixture(d);
    expect(analyzeStaticDagExecution(d)).toEqual({
      maxDepth: depth + 1,
      recursionLimit: depth + 2,
    });
    expect(await start(f)).toMatchObject({ status: 'waiting' });
    const initial = { ...(await state(f)).state, outputs: {}, execution: {} };
    expect(await resume(f, { action: 'approve' })).toMatchObject({ status: 'completed' });
    // 每次 resume 以 checkpoint 当前位置继续，不把所有历史 step 计入本次预算。
    const graph = f.graphs[0]!;
    for (const limit of depth < 2 ? [1] : [depth - 1, depth]) {
      const cfg = {
        configurable: { thread_id: `boundary-${depth}-${limit}` },
        recursionLimit: limit,
      };
      await graph.invoke(initial, cfg);
      const execution = graph.invoke(new Command({ resume: { action: 'approve' } }), cfg);
      if (depth > 1 && limit === depth - 1)
        await expect(execution).rejects.toMatchObject({ name: 'GraphRecursionError' });
      else await expect(execution).resolves.toBeDefined();
    }
  });
});
