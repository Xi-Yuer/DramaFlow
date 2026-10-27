import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { MemorySaver, Command, interrupt } from '@langchain/langgraph';
import {
  StringType,
  isNodeVisibleInCatalog,
  NumberType,
  type RuntimeValue,
  type NodeDefinition,
} from '@dramaflow/contracts';
import {
  DefaultWorkflowOutputResolver,
  workflowStateSchema,
  deriveChildScope,
  validateWorkflowForPublish,
} from '../src/index.js';
import { SUBWORKFLOW_INVOCATION_KEY } from '../src/compiler/subworkflow/state.js';
import { format, subworkflowRuntimeFixture } from './subworkflow-runtime-fixture.js';

async function execute(f: ReturnType<typeof subworkflowRuntimeFixture>, maxConcurrency?: number) {
  const graph = await f.createCompiler().compile(f.definition, f.run);
  return workflowStateSchema.parse(
    await graph.invoke(f.initial(), { ...f.config, ...(maxConcurrency ? { maxConcurrency } : {}) }),
  );
}
describe('正式 SubWorkflow Runtime v1', () => {
  it.each([1, 3, undefined])(
    '固定一次调用，原类型输出和正式身份（maxConcurrency=%s）',
    async (concurrency) => {
      const f = subworkflowRuntimeFixture();
      expect(
        isNodeVisibleInCatalog(f.registry.get('flow.subworkflow', 1).manifest, 'advanced'),
      ).toBe(false);
      expect(validateWorkflowForPublish(f.definition, f.registry)).toHaveLength(2);
      const result = await execute(f, concurrency);
      expect(new DefaultWorkflowOutputResolver().resolve(f.definition, result)).toEqual({
        result: { storage: 'inline', type: StringType, value: 'A-1' },
      });
      const records = f.nodeRuns.getRecords(),
        parent = records.find((row) => row.nodeId === 'sub')!,
        body = records.find((row) => row.nodeId === 'format')!;
      expect(parent).toMatchObject({ scopeKey: 'root', attempt: 1, status: 'completed' });
      expect(parent.childExecutionId).toBeUndefined();
      const children = f.nodeRuns.getItemRecords();
      expect(children).toHaveLength(1);
      const child = children[0]!;
      expect(child).toMatchObject({
        kind: 'subworkflow',
        invocationKey: SUBWORKFLOW_INVOCATION_KEY,
        parentNodeRunId: parent.id,
        metadata: {},
        status: 'completed',
      });
      expect(child).not.toHaveProperty('index');
      expect(child.scopeKey).toBe(
        deriveChildScope('root', {
          kind: 'subworkflow_call',
          ownerOccurrenceId: parent.occurrenceId,
          ownerNodeRunId: parent.id,
          slot: 'graph',
          callKey: SUBWORKFLOW_INVOCATION_KEY,
        }),
      );
      expect(body).toMatchObject({
        scopeKey: child.scopeKey,
        childExecutionId: child.id,
        attempt: 1,
        status: 'completed',
      });
      expect(body.occurrenceId).not.toBe(parent.occurrenceId);
    },
  );
  it('Action chain / DataEdge 不重复调用或改变输出类型', async () => {
    const f = subworkflowRuntimeFixture();
    const second = format('second', 2);
    delete second.inputs.text;
    f.child.nodes.push(second);
    f.child.edges.push({
      id: 'link',
      kind: 'data',
      source: { nodeId: 'format', portKey: 'text' },
      target: { nodeId: 'second', portKey: 'text' },
    });
    f.child.outputs[0]!.source = { nodeId: 'second', outputKey: 'text' };
    expect((await execute(f)).outputs.sub!.text).toMatchObject({
      value: 'A-1-2',
      type: StringType,
    });
    expect(f.nodeRuns.getRecords().filter((row) => row.nodeId !== 'sub')).toHaveLength(2);
  });
  it('parallel + ALL join；多个 outputs 保持标量', async () => {
    const f = subworkflowRuntimeFixture();
    const right = format('right', 2);
    const join: NodeDefinition = { ...format('join'), type: 'test.join', inputs: {}, config: {} };
    f.child.nodes.push(right, join);
    f.child.edges.push(
      ...(['format', 'right'] as const).map((nodeId, index) => ({
        id: nodeId,
        kind: 'data' as const,
        source: { nodeId, portKey: 'text' },
        target: { nodeId: 'join', portKey: index ? 'b' : 'a' },
      })),
    );
    f.child.outputs.push({
      name: 'joined',
      type: StringType,
      source: { nodeId: 'join', outputKey: 'text' },
    });
    const state = await execute(f);
    expect(state.outputs.sub).toMatchObject({
      text: { value: 'A-1' },
      joined: { value: 'A-1|A-2' },
    });
    expect(f.nodeRuns.getRecords().filter((row) => row.nodeId === 'join')).toHaveLength(1);
  });
  it('Template 汇聚多个 Action 上游，仅使用子图依赖', async () => {
    const f = subworkflowRuntimeFixture();
    const consumer = format('consume', 3);
    consumer.inputs.text = {
      type: 'template',
      value: '{{left}}+{{right}}',
      variables: {
        left: { type: 'node_output', nodeId: 'format', portKey: 'text' },
        right: { type: 'node_output', nodeId: 'right', portKey: 'text' },
      },
    };
    f.child.nodes.push(format('right', 2), consumer);
    f.child.outputs[0]!.source = { nodeId: 'consume', outputKey: 'text' };
    expect((await execute(f)).outputs.sub!.text).toMatchObject({ value: 'A-1+A-2-3' });
  });
  it('root / child 同名节点、输入和输出状态隔离', async () => {
    const f = subworkflowRuntimeFixture();
    const root = format('format', 9);
    f.definition.nodes.unshift(root);
    const state = await execute(f);
    expect(state.outputs.format!.text).toMatchObject({ value: 'A-9' });
    expect(state.outputs.sub!.text).toMatchObject({ value: 'A-1' });
    const nodes = f.nodeRuns.getRecords().filter((row) => row.nodeId === 'format');
    expect(new Set(nodes.map((row) => row.occurrenceId)).size).toBe(2);
    expect(new Set(nodes.map((row) => row.scopeKey)).size).toBe(2);
  });
  it('Reference / collection 在 parent input 和 child outputs 边界不 decode/re-encode', async () => {
    const f = subworkflowRuntimeFixture();
    const array = { kind: 'array' as const, itemType: StringType };
    const collection: RuntimeValue = {
      storage: 'collection',
      type: array,
      elements: [
        { storage: 'reference', type: StringType, reference: { kind: 'artifact', id: 'element' } },
      ],
    };
    const reference: RuntimeValue = {
      storage: 'reference',
      type: StringType,
      reference: { kind: 'artifact', id: 'text' },
    };
    f.run.inputs.text = reference;
    f.child.outputs.push({
      name: 'items',
      type: array,
      source: { nodeId: 'format', outputKey: 'items' },
    });
    f.registry.register({
      manifest: {
        type: 'test.pass',
        version: 1,
        executionKind: 'action',
        metadata: { name: '边界探针', category: 'data' },
        inputs: [{ key: 'text', name: '文本', dataType: StringType, required: true }],
        outputs: [
          { key: 'text', name: '文本', dataType: StringType },
          { key: 'items', name: '集合', dataType: array, storagePolicy: 'inline' },
        ],
        config: [],
      },
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ text: z.string(), items: z.array(z.string()) }),
      configSchema: z.object({}),
      execute: async () => ({ text: 'unused', items: [] }),
    });
    f.child.nodes[0]!.type = 'test.pass';
    f.child.nodes[0]!.config = {};
    f.child.nodes[0]!.inputs = { text: { type: 'workflow_input', key: 'text' } };
    f.useExecutor(async (_node, context) => {
      expect(context.state.inputs.text).toEqual(reference);
      expect(context.state.outputs).toEqual({});
      expect(context.state.variables).toEqual({});
      return { output: { text: reference, items: collection } };
    });
    const state = await execute(f);
    expect(state.outputs.sub).toEqual({ text: reference, items: collection });
    expect(f.nodeRuns.getRecords()[0]!.outputs).toEqual({ text: reference, items: collection });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it('Binding / invocation failure 只结束 Parent，不伪造 ChildExecution', async () => {
    const f = subworkflowRuntimeFixture();
    f.run.inputs.text = { storage: 'inline', type: NumberType, value: 2 };
    await expect(execute(f)).rejects.toMatchObject({ stage: 'resolve_input' });
    expect(f.nodeRuns.getItemRecords()).toHaveLength(0);
    expect(f.nodeRuns.getRecords()).toMatchObject([{ nodeId: 'sub', status: 'failed' }]);
  });
  it('child Action 普通失败同时结束 Child 与 Parent，并保留原异常', async () => {
    const f = subworkflowRuntimeFixture();
    const cause = new Error('child failed');
    const failure = vi.spyOn(f.codec, 'decodeRecord').mockRejectedValue(cause);
    await expect(execute(f)).rejects.toMatchObject({ stage: 'decode_input', cause });
    expect(failure).toHaveBeenCalledOnce();
    expect(f.nodeRuns.getItemRecords()).toMatchObject([{ status: 'failed' }]);
    expect(f.nodeRuns.getRecords().every((row) => row.status === 'failed')).toBe(true);
  });
  it('output resolution failure 结束 Child / Parent', async () => {
    const f = subworkflowRuntimeFixture();
    f.useExecutor(async () => ({ output: {} }));
    await expect(execute(f)).rejects.toMatchObject({ stage: 'validate_output' });
    expect(f.nodeRuns.getItemRecords()).toMatchObject([{ status: 'failed' }]);
    expect(f.nodeRuns.getRecords()).toMatchObject([{ nodeId: 'sub', status: 'failed' }]);
  });
  it('ChildExecution 创建基础设施错误不包装成业务 failed', async () => {
    const f = subworkflowRuntimeFixture();
    const error = new Error('repository unavailable');
    f.nodeRuns.getOrCreateChildExecutionRunning.mockRejectedValue(error);
    await expect(execute(f)).rejects.toBe(error);
    expect(f.nodeRuns.getRecords()).toMatchObject([{ nodeId: 'sub', status: 'running' }]);
    expect(f.nodeRuns.getItemRecords()).toHaveLength(0);
  });
  it('原生 checkpoint 重建复用父 attempt / child ID / scope，完成过的 Action 不重放', async () => {
    const f = subworkflowRuntimeFixture();
    const saver = new MemorySaver();
    f.registry.register({
      manifest: {
        type: 'test.pause',
        version: 1,
        executionKind: 'action',
        metadata: { name: '测试暂停', category: 'data' },
        inputs: [{ key: 'text', name: '文本', dataType: StringType }],
        outputs: [{ key: 'text', name: '文本', dataType: StringType }],
        config: [],
      },
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ text: z.string() }),
      configSchema: z.object({}),
      execute: async (input: { text: string }) => ({
        text: input.text + String(interrupt({ kind: 'test_only' })),
      }),
    });
    const pause: NodeDefinition = {
      ...format('pause'),
      type: 'test.pause',
      inputs: {},
      config: {},
    };
    f.child.nodes.push(pause);
    f.child.edges.push({
      id: 'wait',
      kind: 'data',
      source: { nodeId: 'format', portKey: 'text' },
      target: { nodeId: 'pause', portKey: 'text' },
    });
    f.child.outputs[0]!.source = { nodeId: 'pause', outputKey: 'text' };
    await (
      await f.createCompiler(saver).compile(f.definition, f.run)
    ).invoke(f.initial(), f.config);
    const before = f.nodeRuns.getItemRecords()[0]!;
    expect(before.status).toBe('running');
    const state = workflowStateSchema.parse(
      await (
        await f.createCompiler(saver).compile(f.definition, f.run)
      ).invoke(new Command({ resume: '!' }), f.config),
    );
    expect(state.outputs.sub!.text).toMatchObject({ value: 'A-1!' });
    expect(f.nodeRuns.getItemRecords()).toMatchObject([
      { id: before.id, scopeKey: before.scopeKey, status: 'completed' },
    ]);
    expect(f.nodeRuns.getRecords().filter((row) => row.nodeId === 'sub')).toHaveLength(1);
    expect(f.nodeRuns.getRecords().filter((row) => row.nodeId === 'format')).toHaveLength(1);
  });
});
