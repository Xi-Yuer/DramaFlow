import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command, MemorySaver, type StateSnapshot } from '@langchain/langgraph';
import { NumberType, StringType } from '@dramaflow/contracts';
import { z } from 'zod';
import {
  DefaultWorkflowOutputResolver,
  NodeExecutionError,
  deriveChildScope,
  graphExecutionIdentitySchema,
  validateWorkflowForPublish,
  workflowStateSchema,
  type WorkflowState,
} from '../../../src/index.js';
import * as graphCompiler from '../../../src/compiler/graph/graph-compiler.js';
import {
  INVOCATION,
  ITEM_RUN,
  itemInvocationSchema,
} from '../../../src/compiler/iteration/state.js';
import {
  SUBWORKFLOW_FRAME,
  SUBWORKFLOW_CALL,
  subworkflowFrameSchema,
  subworkflowCallSchema,
} from '../../../src/compiler/subworkflow/state.js';
import {
  iterationSubworkflowFixture as fixture,
  pauseSubworkflowInput,
  texts,
  expected,
  array,
} from '../../fixtures/iteration-subworkflow-fixture.js';

const path = [{ nodeId: 'iterate', graphKey: 'body' }] as const;
afterEach(() => vi.restoreAllMocks());

type Fixture = ReturnType<typeof fixture>;

// 只通过 repository identity、明确 FK 和 metadata.index 走父子链；不解析 scope。
function hierarchy(f: Fixture) {
  const nodes = f.nodeRuns
    .getRecords()
    .filter((row) => row.childExecutionId !== undefined || row.nodeId === 'iterate');
  const children = f.nodeRuns.getItemRecords();
  const roots = nodes.filter((row) => row.childExecutionId === undefined);
  expect(roots).toHaveLength(1);
  const owner = roots[0]!;
  expect(owner).toMatchObject({ nodeId: 'iterate', scopeKey: 'root', attempt: 1 });
  const items = children
    .filter((row) => row.parentNodeRunId === owner.id)
    .sort((a, b) => Number(a.metadata.index) - Number(b.metadata.index));
  expect(items).toHaveLength(3);
  const rows = items.map((item, index) => {
    expect(item).toMatchObject({ kind: 'iteration_item', metadata: { index } });
    const parents = nodes.filter((row) => row.childExecutionId === item.id);
    expect(parents).toHaveLength(1);
    const parent = parents[0]!;
    expect(parent).toMatchObject({ nodeId: 'sub', scopeKey: item.scopeKey, attempt: 1 });
    expect(f.nodeRuns.getOccurrence(parent.occurrenceId).scopeKey).toBe(item.scopeKey);
    expect(parent.inputs?.text).toMatchObject({ value: texts[index] });
    expect(parent.inputs?.index).toMatchObject({ value: index });
    const calls = children.filter((row) => row.parentNodeRunId === parent.id);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call).toMatchObject({ kind: 'subworkflow', parentNodeId: 'sub' });
    expect(call.scopeKey).not.toBe(item.scopeKey);
    const actions = nodes.filter((row) => row.childExecutionId === call.id);
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action).toMatchObject({ nodeId: 'action', scopeKey: call.scopeKey, attempt: 1 });
    expect(f.nodeRuns.getOccurrence(action.occurrenceId).scopeKey).toBe(call.scopeKey);
    expect(action.inputs?.text).toMatchObject({ value: texts[index] });
    expect(action.inputs?.index).toMatchObject({ value: index });
    expect(action.outputs?.text).toMatchObject({ value: expected[index] });
    expect(parent.outputs?.text).toEqual(action.outputs?.text);
    return {
      index,
      itemId: item.id,
      itemScope: item.scopeKey,
      subId: parent.id,
      subOccurrence: parent.occurrenceId,
      callId: call.id,
      callScope: call.scopeKey,
      actionId: action.id,
      actionOccurrence: action.occurrenceId,
    };
  });
  for (const key of [
    'itemId',
    'subId',
    'subOccurrence',
    'callId',
    'actionId',
    'actionOccurrence',
  ] as const)
    expect(new Set(rows.map((row) => row[key])).size).toBe(3);
  expect(new Set(nodes.map((row) => row.occurrenceId)).size).toBe(7);
  expect(children).toHaveLength(6);
  expect(nodes).toHaveLength(7);
  return { owner, rows };
}
function result(f: Fixture, state: unknown) {
  return new DefaultWorkflowOutputResolver().resolve(
    f.definition,
    workflowStateSchema.parse(state),
  );
}
// 拷贝官方 Saver 已序列化的 checkpoint / pending writes（含 task path），不复制 graph/runtime。
function reconstructSaver(source: MemorySaver) {
  const restored = new MemorySaver();
  restored.storage = structuredClone(source.storage);
  restored.writes = structuredClone(source.writes);
  return restored;
}
async function checkpointIdentities(f: Fixture) {
  const namespaces = new Set<string>();
  const items = new Set<string>(),
    calls = new Set<string>();
  for await (const tuple of f.saver.list(f.config)) {
    const namespace = tuple.config.configurable?.checkpoint_ns;
    if (typeof namespace === 'string' && namespace) namespaces.add(namespace);
    const values = tuple.checkpoint.channel_values;
    if (values[INVOCATION]) {
      expect(itemInvocationSchema.parse(values[INVOCATION]).definitionLocation).toEqual({
        workflowVersionId: f.run.workflowVersionId,
        path,
      });
      if (typeof values[ITEM_RUN] === 'string') items.add(values[ITEM_RUN]);
    }
    if (values[SUBWORKFLOW_FRAME])
      calls.add(subworkflowFrameSchema.parse(values[SUBWORKFLOW_FRAME]).childExecutionId);
    if (values[SUBWORKFLOW_CALL])
      calls.add(subworkflowCallSchema.parse(values[SUBWORKFLOW_CALL]).childExecutionId);
  }
  expect(namespaces.size).toBeGreaterThan(3);
  expect(items).toEqual(
    new Set(
      f.nodeRuns
        .getItemRecords()
        .filter((row) => row.kind === 'iteration_item')
        .map((row) => row.id),
    ),
  );
  expect(calls).toEqual(
    new Set(
      f.nodeRuns
        .getItemRecords()
        .filter((row) => row.kind === 'subworkflow')
        .map((row) => row.id),
    ),
  );
}

describe('Iteration → SubWorkflow 原生组合 checkpoint 与身份', () => {
  it.each([2, 3, undefined])(
    '三个 Item 同名 sub/action 完全隔离，乱序完成仍按 index 聚合（maxConcurrency=%s）',
    async (maxConcurrency) => {
      const f = fixture();
      const state = await f
        .compile()
        .invoke(f.initial(), { ...f.config, ...(maxConcurrency ? { maxConcurrency } : {}) });
      expect(result(f, state)).toEqual({
        result: { storage: 'inline', type: array, value: expected },
      });
      hierarchy(f);
      expect(f.finished).not.toEqual(texts);
      expect([...f.finished].sort()).toEqual([...texts].sort());
      expect(f.peak()).toBeGreaterThan(1);
      if (maxConcurrency) expect(f.peak()).toBeLessThanOrEqual(maxConcurrency);
      expect(f.nodeRuns.getRecords().every((row) => row.status === 'completed')).toBe(true);
      await checkpointIdentities(f);
    },
  );

  it('三个 Item 完成后在 root 后继暂停：重建跳过终态 frame，绝不调用 child reuse', async () => {
    const f = fixture();
    f.definition.nodes.push({
      ...f.child.nodes[0]!,
      id: 'after',
      type: 'data.format_text',
      inputs: { text: { type: 'constant', value: 'done' }, index: { type: 'constant', value: 99 } },
    });
    f.definition.edges.push({
      id: 'after-iteration',
      kind: 'control',
      source: { nodeId: 'iterate' },
      target: { nodeId: 'after' },
    });
    const graph = f.compile();
    await graph.invoke(f.initial(), { ...f.config, maxConcurrency: 3, interruptBefore: ['after'] });
    const before = hierarchy(f);
    expect(before.owner.status).toBe('completed');
    expect(f.nodeRuns.getItemRecords().every((row) => row.status === 'completed')).toBe(true);
    expect(
      f.nodeRuns
        .getRecords()
        .filter((row) => row.childExecutionId)
        .every((row) => row.status === 'completed'),
    ).toBe(true);
    await checkpointIdentities(f);
    const snapshot = await graph.getState(f.config, { subgraphs: true });
    expect(snapshot.next).toEqual(['after']);
    const rejectReplay = new Error('恢复必须跳过完成任务，不能重放或复用 terminal child');
    f.execute.mockRejectedValue(rejectReplay);
    const create = f.nodeRuns.createRunning.getMockImplementation()!;
    f.nodeRuns.createRunning.mockImplementation(async (input) => {
      expect(input).toMatchObject({ nodeId: 'after' });
      expect(input.childExecutionId).toBeUndefined();
      return create(input);
    });
    const occurrence = f.nodeRuns.getOrCreateOccurrence.getMockImplementation()!;
    f.nodeRuns.getOrCreateOccurrence.mockImplementation(async (input) => {
      expect(input).toMatchObject({ nodeId: 'after', scopeKey: 'root' });
      return occurrence(input);
    });
    f.nodeRuns.getOrCreateChildExecutionRunning.mockRejectedValue(rejectReplay);
    f.nodeRuns.getOrCreateIterationItemRunning.mockRejectedValue(rejectReplay);
    f.nodeRuns.markChildExecutionCompleted.mockRejectedValue(rejectReplay);
    f.nodeRuns.markIterationItemCompleted.mockRejectedValue(rejectReplay);
    const saved = reconstructSaver(f.saver);
    const restored = f.compile(undefined, undefined, { checkpointer: saved });
    expect((await restored.getState(f.config)).config).toEqual(snapshot.config);
    expect(result(f, await restored.invoke(null, f.config))).toEqual({
      result: { storage: 'inline', type: array, value: expected },
    });
    expect(hierarchy(f).rows).toEqual(before.rows);
    expect(f.nodeRuns.getRecords().every((row) => row.status === 'completed')).toBe(true);
    expect(f.execute).toHaveBeenCalledTimes(3);
    expect(f.nodeRuns.createRunning).toHaveBeenCalledTimes(8);
    expect(f.nodeRuns.getOrCreateChildExecutionRunning).toHaveBeenCalledTimes(6);
  });

  it('两个 Item 完成、beta 在 Action 前暂停：重建仅执行 beta Action，不新增 Parent attempt / child', async () => {
    const f = fixture();
    const compiler = pauseSubworkflowInput('beta');
    const graph = f.compile();
    expect(
      compiler.mock.calls.map(([context]) => context.plan.definitionLocation.path),
    ).toContainEqual([...path, { nodeId: 'sub', graphKey: 'graph' }]);
    await graph.invoke(f.initial(), { ...f.config, maxConcurrency: 3 });
    const children = f.nodeRuns.getItemRecords();
    const items = children
      .filter((row) => row.kind === 'iteration_item')
      .sort((a, b) => Number(a.metadata.index) - Number(b.metadata.index));
    expect(items.map((row) => row.status)).toEqual(['completed', 'running', 'completed']);
    expect(f.finished.sort()).toEqual(['alpha', 'gamma']);
    const owners = f.nodeRuns.getRecords().filter((row) => row.nodeId !== 'action');
    const betaParent = owners.find((row) => row.childExecutionId === items[1]!.id)!;
    const betaCall = children.find((row) => row.parentNodeRunId === betaParent.id)!;
    const snapshot = await graph.getState(f.config, { subgraphs: true });
    const pending: string[] = [];
    const visit = (state: StateSnapshot) => {
      for (const task of state.tasks) {
        pending.push(task.name);
        if (task.state && 'tasks' in task.state) visit(task.state);
      }
    };
    visit(snapshot);
    expect(pending).toEqual(
      expect.arrayContaining(['iterate', 'body', 'sub', 'graph', '__dramaflow_subworkflow_inputs']),
    );
    await checkpointIdentities(f);
    const create = f.nodeRuns.createRunning.getMockImplementation()!;
    f.nodeRuns.createRunning.mockImplementation(async (input) => {
      expect(input).toMatchObject({ nodeId: 'action', childExecutionId: betaCall.id });
      return create(input);
    });
    const rejectReplay = new Error('不能重新创建 Parent / ChildExecution');
    f.nodeRuns.getOrCreateChildExecutionRunning.mockRejectedValue(rejectReplay);
    f.nodeRuns.getOrCreateIterationItemRunning.mockRejectedValue(rejectReplay);
    const restored = f.compile(undefined, undefined, { checkpointer: reconstructSaver(f.saver) });
    expect(result(f, await restored.invoke(new Command({ resume: 'ok' }), f.config))).toEqual({
      result: { storage: 'inline', type: array, value: expected },
    });
    hierarchy(f);
    expect(
      f.nodeRuns
        .getRecords()
        .filter((row) => row.nodeId !== 'action')
        .map((row) => [row.id, row.occurrenceId, row.attempt]),
    ).toEqual(owners.map((row) => [row.id, row.occurrenceId, row.attempt]));
    expect(f.nodeRuns.getItemRecords().map((row) => row.id)).toEqual(children.map((row) => row.id));
    expect(f.execute).toHaveBeenCalledTimes(3);
    expect(f.nodeRuns.createRunning).toHaveBeenCalledTimes(7);
    expect(f.nodeRuns.getRecords().every((row) => row.status === 'completed')).toBe(true);
    expect(f.nodeRuns.markFailed).not.toHaveBeenCalled();
  });

  it('prepare 真正重新执行：同一 Item occurrence 分配新 Parent attempt，其 child 不复用旧 attempt', async () => {
    const f = fixture();
    const occurrence = await f.nodeRuns.getOrCreateOccurrence({
      workflowRunId: f.run.id,
      nodeId: 'iterate',
      scopeKey: 'root',
    });
    const owner = await f.nodeRuns.createRunning({
      workflowRunId: f.run.id,
      nodeId: 'iterate',
      occurrenceId: occurrence.id,
    });
    await f.nodeRuns.updateInputs(owner.id, f.run.inputs);
    const item = await f.nodeRuns.getOrCreateIterationItemRunning({
      workflowRunId: f.run.id,
      parentNodeRunId: owner.id,
      parentNodeId: 'iterate',
      index: 0,
      scopeKey: deriveChildScope('root', {
        kind: 'iteration_item',
        ownerOccurrenceId: occurrence.id,
        ownerNodeRunId: owner.id,
        slot: 'body',
        index: 0,
      }),
    });
    const config = {
      ...f.config,
      configurable: {
        ...f.config.configurable,
        graphExecution: { scopeKey: item.scopeKey, childExecutionId: item.id },
      },
    };
    const execution: graphCompiler.GraphExecutionContext<WorkflowState> = {
      resolve: (_state, current) =>
        graphExecutionIdentitySchema.parse(current.configurable?.graphExecution),
    };
    const input: WorkflowState = {
      ...f.initial(),
      inputs: {
        text: { storage: 'inline', type: StringType, value: 'alpha' },
        index: { storage: 'inline', type: NumberType, value: 0 },
      },
    };
    // 两次独立的受控内部调用，第二次刻意没有旧 checkpoint；不是 checkpoint resume / 产品 Retry。
    for (let attempt = 1; attempt <= 2; attempt++) {
      const graph = f.compile(f.body, f.run, { checkpointer: new MemorySaver(), execution, path });
      const state = workflowStateSchema.parse(await graph.invoke(input, config));
      expect(state.outputs.sub?.text).toMatchObject({ value: 'result-0' });
    }
    const parents = f.nodeRuns.getRecords().filter((row) => row.childExecutionId === item.id);
    expect(parents.map((row) => row.attempt)).toEqual([1, 2]);
    expect(new Set(parents.map((row) => row.occurrenceId)).size).toBe(1);
    const calls = parents.map((parent) =>
      f.nodeRuns.getItemRecords().find((row) => row.parentNodeRunId === parent.id)!,
    );
    expect(new Set(calls.map((row) => row.id)).size).toBe(2);
    expect(new Set(calls.map((row) => row.scopeKey)).size).toBe(2);
    for (const [index, call] of calls.entries()) {
      expect(call).toMatchObject({
        kind: 'subworkflow',
        parentNodeRunId: parents[index]!.id,
        status: 'completed',
      });
      const actions = f.nodeRuns.getRecords().filter((row) => row.childExecutionId === call.id);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        nodeId: 'action',
        attempt: 1,
        scopeKey: call.scopeKey,
        status: 'completed',
      });
    }
    expect(f.nodeRuns.getItemRecords().find((row) => row.id === item.id)?.status).toBe('running');
  });

  it('beta Action 失败逐层结束对应 invocation，成功兄弟与各自 output 保持隔离', async () => {
    const f = fixture();
    const execute = f.execute.getMockImplementation()!;
    const cause = new Error('beta failed');
    f.execute.mockImplementation(async (raw, config, context) => {
      const input = z.object({ text: z.string() }).parse(raw);
      if (input.text === 'beta') {
        await new Promise((resolve) => setTimeout(resolve, 80));
        throw cause;
      }
      return execute(raw, config, context);
    });
    await expect(
      f.compile().invoke(f.initial(), { ...f.config, maxConcurrency: 3 }),
    ).rejects.toBeInstanceOf(NodeExecutionError);
    const children = f.nodeRuns.getItemRecords();
    const items = children
      .filter((row) => row.kind === 'iteration_item')
      .sort((a, b) => Number(a.metadata.index) - Number(b.metadata.index));
    expect(items.map((row) => row.status)).toEqual(['completed', 'failed', 'completed']);
    const nodes = f.nodeRuns.getRecords();
    const betaParent = nodes.find((row) => row.childExecutionId === items[1]!.id)!;
    const betaCall = children.find((row) => row.parentNodeRunId === betaParent.id)!;
    const betaAction = nodes.find((row) => row.childExecutionId === betaCall.id)!;
    expect([betaParent.status, betaCall.status, betaAction.status]).toEqual([
      'failed',
      'failed',
      'failed',
    ]);
    expect(nodes.find((row) => row.nodeId === 'iterate')).toMatchObject({
      status: 'failed',
      attempt: 1,
    });
    expect(nodes.find((row) => row.nodeId === 'iterate')?.outputs).toBeUndefined();
    for (const index of [0, 2])
      expect(
        nodes.find((row) => row.childExecutionId === items[index]!.id)?.outputs?.text,
      ).toMatchObject({ value: expected[index] });
    expect(nodes).toHaveLength(7);
    expect(children).toHaveLength(6);
  });

  it('正式 Publish / Compiler 接受组合，maxConcurrency=1 仍在审计前 fail-fast', async () => {
    const f = fixture();
    await expect(
      f.compile().invoke(f.initial(), { ...f.config, maxConcurrency: 1 }),
    ).rejects.toMatchObject({ code: 'ITERATION_LANGGRAPH_CONCURRENCY_UNSUPPORTED' });
    expect(f.nodeRuns.getRecords()).toEqual([]);
    expect(f.nodeRuns.getItemRecords()).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
    expect(() => validateWorkflowForPublish(f.definition, f.registry)).not.toThrow();
    const compiled = await f.createCompiler().compile(f.definition, f.run);
    const state = await compiled.invoke(f.initial(), f.config);
    expect(
      new DefaultWorkflowOutputResolver().resolve(f.definition, workflowStateSchema.parse(state)),
    ).toMatchObject({ result: { value: expected } });
    hierarchy(f);
  });
});

it.each(['flow.iteration', 'flow.subworkflow', 'flow.human_review', 'flow.if'])(
  '正式组合内部仍递归拒绝 %s',
  async (type) => {
    const f = fixture();
    f.child.nodes[0]!.type = type;
    const issue = {
      code: 'SUBWORKFLOW_GRAPH_CAPABILITY_UNSUPPORTED',
      definitionPath: [
        { nodeId: 'iterate', graphKey: 'body' },
        { nodeId: 'sub', graphKey: 'graph' },
      ],
    };
    expect(() => validateWorkflowForPublish(f.definition, f.registry)).toThrow(
      expect.objectContaining(issue),
    );
    await expect(f.createCompiler().compile(f.definition, f.run)).rejects.toMatchObject(issue);
    expect(f.nodeRuns.getRecords()).toEqual([]);
  },
);
it('Body gate 不放行 SubWorkflow 的其他版本，子图 Candidate 仍被拒绝', async () => {
  const f = fixture();
  const sub = f.registry.get('flow.subworkflow', 1);
  f.registry.register({
    ...sub,
    manifest: { ...sub.manifest, version: 2, portDerivation: undefined },
  });
  const composite = f.parent.composite;
  delete f.parent.composite;
  f.parent.typeVersion = 2;
  expect(() => validateWorkflowForPublish(f.definition, f.registry)).toThrow(
    expect.objectContaining({ code: 'ITERATION_BODY_CAPABILITY_UNSUPPORTED' }),
  );
  await expect(f.createCompiler().compile(f.definition, f.run)).rejects.toMatchObject({
    code: 'ITERATION_BODY_CAPABILITY_UNSUPPORTED',
  });
  f.parent.typeVersion = 1;
  f.parent.composite = composite;
  f.child.nodes.push({ ...structuredClone(f.child.nodes[0]!), id: 'other' });
  f.child.nodes.push({ ...structuredClone(f.child.nodes[0]!), id: 'another' });
  f.child.nodes[0]!.inputs.text = {
    type: 'candidate',
    sources: [
      { type: 'node_output', nodeId: 'other', portKey: 'text' },
      { type: 'node_output', nodeId: 'another', portKey: 'text' },
    ],
  };
  expect(() => validateWorkflowForPublish(f.definition, f.registry)).toThrow(
    expect.objectContaining({ code: 'SUBWORKFLOW_GRAPH_CANDIDATE_UNSUPPORTED' }),
  );
  await expect(f.createCompiler().compile(f.definition, f.run)).rejects.toMatchObject({
    code: 'SUBWORKFLOW_GRAPH_CANDIDATE_UNSUPPORTED',
  });
});
