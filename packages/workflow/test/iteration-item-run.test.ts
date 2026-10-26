import { describe, expect, it } from 'vitest';
import {
  Command,
  END,
  GraphInterrupt,
  MemorySaver,
  ParentCommand,
  interrupt,
} from '@langchain/langgraph';
import { StringType } from '@dramaflow/contracts';
import { z } from 'zod';
import { deriveChildScope, workflowStateSchema } from '../src/index.js';
import { arrayType, iterationRuntimeFixture } from './iteration-runtime-fixture.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ChildExecution identity 与生命周期', () => {
  it('[A, B, C] 创建三个正式 item，Body NodeRun 按外键关联，同属一次父 NodeRun', async () => {
    const f = iterationRuntimeFixture();
    f.registry.register({
      manifest: {
        type: 'test.episode',
        version: 1,
        executionKind: 'action',
        metadata: { name: '分集', category: 'data' },
        inputs: [{ key: 'item', name: '集', dataType: StringType, required: true }],
        outputs: [{ key: 'text', name: '文本', dataType: StringType }],
        config: [],
      },
      inputSchema: z.object({ item: z.string() }),
      configSchema: z.object({}),
      outputSchema: z.object({ text: z.string() }),
      execute: async (input: { item: string }) => ({ text: input.item }),
    });
    f.loop.inputs = { items: { type: 'workflow_input', key: 'items' } };
    f.loop.composite = {
      kind: 'iteration',
      itemType: StringType,
      invariantInputs: [],
      bodyInputMapping: [{ target: 'item', source: { type: 'current_item' } }],
      body: {
        inputs: [{ name: 'item', type: StringType, required: true }],
        nodes: [
          {
            id: 'episode',
            name: '集',
            type: 'test.episode',
            typeVersion: 1,
            inputs: { item: { type: 'workflow_input', key: 'item' } },
            config: {},
            ui: { position: { x: 0, y: 0 } },
          },
        ],
        edges: [],
        outputs: [
          { name: 'text', type: StringType, source: { nodeId: 'episode', outputKey: 'text' } },
        ],
      },
    };
    f.definition.inputs = [{ name: 'items', type: arrayType(StringType), required: true }];
    f.definition.nodes = [f.loop];
    f.definition.edges = [];
    f.definition.outputs = [];
    f.run.inputs.items = { storage: 'inline', type: arrayType(StringType), value: ['A', 'B', 'C'] };
    const compiled = await f.createCompiler().compile(f.definition, f.run);
    await compiled.invoke(f.initial(), f.config);
    const items = f.nodeRuns.getItemRecords();
    const nodes = f.nodeRuns.getRecords();
    const parent = nodes.find((row) => row.nodeId === 'iteration')!;
    expect(items.map((item) => Number(item.metadata.index)).sort()).toEqual([0, 1, 2]);
    expect(new Set(items.map((item) => item.id)).size).toBe(3);
    expect(new Set(items.map((item) => item.scopeKey)).size).toBe(3);
    for (const item of items) {
      expect(item).toMatchObject({
        workflowRunId: f.run.id,
        parentNodeRunId: parent.id,
        parentNodeId: 'iteration',
        status: 'completed',
        createdAt: expect.any(String),
        startedAt: expect.any(String),
        completedAt: expect.any(String),
      });
      expect(item).not.toHaveProperty('inputs');
      expect(item).not.toHaveProperty('outputs');
      const body = nodes.filter((row) => row.childExecutionId === item.id);
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        nodeId: 'episode',
        scopeKey: item.scopeKey,
        attempt: 1,
        inputs: { item: { value: ['A', 'B', 'C'][Number(item.metadata.index)] } },
      });
    }
  });

  it('并行 item 完成乱序时，index、Body 外键和独立状态不受影响', async () => {
    const f = iterationRuntimeFixture(3, { delay: true });
    let finish: () => void = () => {
      throw new Error('未初始化');
    };
    const allStarted = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started = 0;
    f.execute.mockImplementation(async (input) => {
      if (++started === 3) finish();
      await allStarted;
      await delay((3 - input.index) * 10);
      return { result: input.value, text: String(input.index), list: [] };
    });
    const compiled = await f.createCompiler().compile(f.definition, f.run);
    const running = compiled.invoke(f.initial(), f.config);
    await allStarted;
    expect(f.nodeRuns.getItemRecords().map((row) => row.status)).toEqual([
      'running',
      'running',
      'running',
    ]);
    await running;
    for (const item of f.nodeRuns.getItemRecords()) {
      expect(item.status).toBe('completed');
      const body = f.nodeRuns.getRecords().find((row) => row.childExecutionId === item.id)!;
      expect(body.inputs?.index).toMatchObject({ value: Number(item.metadata.index) });
      expect(body.scopeKey).toBe(item.scopeKey);
    }
  });

  it('一个 item 业务失败，其他已完成 item 保留自己的身份和终态', async () => {
    const f = iterationRuntimeFixture();
    f.execute.mockImplementation(async (input) => {
      if (input.index === 1) {
        await delay(40);
        throw new Error('敏感供应商信息');
      }
      return { result: input.value, text: String(input.index), list: [] };
    });
    const compiled = await f.createCompiler().compile(f.definition, f.run);
    await expect(compiled.invoke(f.initial(), f.config)).rejects.toMatchObject({
      code: 'NODE_EXECUTION_FAILED',
    });
    const items = f.nodeRuns
      .getItemRecords()
      .sort((a, b) => Number(a.metadata.index) - Number(b.metadata.index));
    expect(items.map((row) => row.status)).toEqual(['completed', 'failed', 'completed']);
    for (const item of items) {
      const body = f.nodeRuns.getRecords().find((row) => row.childExecutionId === item.id)!;
      expect(body.inputs?.index).toMatchObject({ value: Number(item.metadata.index) });
      expect(body.status).toBe(item.status);
    }
    expect(f.nodeRuns.getRecords().find((row) => row.nodeId === 'iteration')?.status).toBe(
      'failed',
    );
    expect(JSON.stringify(items)).not.toContain('敏感供应商信息');
  });

  it('同 item 并行 Body 分支失败，不覆盖首次失败或影响其他 item', async () => {
    const f = iterationRuntimeFixture(1);
    f.body.nodes = [f.bodyNode('left'), f.bodyNode('right')];
    f.body.outputs = [];
    f.definition.nodes = [f.loop];
    f.definition.edges = [];
    f.definition.outputs = [];
    f.execute.mockRejectedValue(new Error('失败'));
    const compiled = await f.createCompiler().compile(f.definition, f.run);
    await expect(compiled.invoke(f.initial(), f.config)).rejects.toBeInstanceOf(AggregateError);
    expect(f.nodeRuns.getItemRecords()).toMatchObject([{ status: 'failed' }]);
    const body = f.nodeRuns.getRecords().filter((row) => row.nodeId !== 'iteration');
    expect(new Set(body.map((row) => row.childExecutionId)).size).toBe(1);
    expect(body.every((row) => row.status === 'failed')).toBe(true);
  });

  it.each([new GraphInterrupt(), new ParentCommand(new Command({ goto: END }))])(
    '%s 控制信号不触发 item 或父 NodeRun failed',
    async (signal) => {
      const f = iterationRuntimeFixture(1);
      f.execute.mockRejectedValue(signal);
      const compiled = await f.createCompiler().compile(f.definition, f.run);
      // goto 由原生外层图解释；控制路径不写入业务失败。
      await compiled.invoke(f.initial(), f.config);
      expect(f.nodeRuns.getItemRecords()).toMatchObject([{ status: 'running' }]);
      expect(f.nodeRuns.getRecords().every((row) => row.status === 'running')).toBe(true);
      expect(f.nodeRuns.markIterationItemFailed).not.toHaveBeenCalled();
      expect(f.nodeRuns.markFailed).not.toHaveBeenCalled();
    },
  );

  it('原生 interrupt 后 checkpoint 重建保留 item ID，不新增父 attempt 或 item', async () => {
    const f = iterationRuntimeFixture(1);
    f.execute.mockImplementation(async (input) => {
      interrupt({ kind: 'test_only' });
      return { result: input.value, text: 'ok', list: [] };
    });
    const saver = new MemorySaver();
    const compiled = await f.createCompiler(saver).compile(f.definition, f.run);
    await compiled.invoke(f.initial(), f.config);
    const items = f.nodeRuns.getItemRecords();
    expect(items).toMatchObject([{ status: 'running' }]);
    const snapshot = await compiled.getState(f.config, { subgraphs: true });
    expect(snapshot.next).toContain('iteration');
    const restored = await f.createCompiler(saver).compile(f.definition, f.run);
    const result = workflowStateSchema.parse(
      await restored.invoke(new Command({ resume: 'ok' }), f.config),
    );
    expect(result.outputs.iteration).toBeDefined();
    expect(f.nodeRuns.getItemRecords()).toMatchObject([{ id: items[0]!.id, status: 'completed' }]);
    expect(f.nodeRuns.getRecords().filter((row) => row.nodeId === 'iteration')).toHaveLength(1);
    expect(f.nodeRuns.markIterationItemFailed).not.toHaveBeenCalled();
  });

  it('普通 Action 输出数组不创建 ItemRun', async () => {
    const f = iterationRuntimeFixture(1);
    f.definition.nodes = [
      {
        ...f.bodyNode('array_action'),
        inputs: {
          value: { type: 'constant', value: 7 },
          index: { type: 'constant', value: 0 },
        },
      },
    ];
    f.definition.edges = [];
    f.definition.outputs = [];
    const compiled = await f.createCompiler().compile(f.definition, f.run);
    const result = workflowStateSchema.parse(await compiled.invoke(f.initial(), f.config));
    expect(result.outputs.array_action?.list).toMatchObject({ value: [7, 0] });
    expect(f.nodeRuns.getItemRecords()).toEqual([]);
    expect(f.nodeRuns.getOrCreateIterationItemRunning).not.toHaveBeenCalled();
  });

  it('item 完成记录失败保持 running，不反向标记业务 failed', async () => {
    const f = iterationRuntimeFixture(1);
    const failure = new Error('仓储不可用');
    f.nodeRuns.markIterationItemCompleted.mockRejectedValue(failure);
    const graph = await f.createCompiler().compile(f.definition, f.run);
    await expect(graph.invoke(f.initial(), f.config)).rejects.toBe(failure);
    expect(f.nodeRuns.getItemRecords()).toMatchObject([{ status: 'running' }]);
    expect(f.nodeRuns.getRecords().find((row) => row.nodeId === 'iteration')?.status).toBe(
      'running',
    );
    expect(f.nodeRuns.markIterationItemFailed).not.toHaveBeenCalled();
    expect(f.nodeRuns.markFailed).not.toHaveBeenCalled();
  });

  it('Body 仓储故障直接传播，不把 item 误记成业务失败', async () => {
    const f = iterationRuntimeFixture(1);
    const create = f.nodeRuns.createRunning.getMockImplementation()!;
    const failure = new Error('Body 审计创建不可用');
    f.nodeRuns.createRunning.mockImplementation(async (input) => {
      if (input.childExecutionId) throw failure;
      return create(input);
    });
    const graph = await f.createCompiler().compile(f.definition, f.run);
    await expect(graph.invoke(f.initial(), f.config)).rejects.toBe(failure);
    expect(f.nodeRuns.getItemRecords()).toMatchObject([{ status: 'running' }]);
    expect(f.nodeRuns.markIterationItemFailed).not.toHaveBeenCalled();
  });

  it('业务失败且 ItemRun 失败记录也失败时保留两个原因', async () => {
    const f = iterationRuntimeFixture(1);
    const business = new Error('业务失败');
    const recording = new Error('ItemRun 记录不可用');
    f.execute.mockRejectedValue(business);
    f.nodeRuns.markIterationItemFailed.mockRejectedValue(recording);
    const graph = await f.createCompiler().compile(f.definition, f.run);
    await expect(graph.invoke(f.initial(), f.config)).rejects.toMatchObject({
      name: 'ChildExecutionRecordingError',
      childExecutionId: expect.any(String),
      executionError: { cause: business },
      recordingError: recording,
    });
    expect(f.nodeRuns.getItemRecords()).toMatchObject([{ status: 'running' }]);
  });

  it('新父 attempt 的相同 index 产生新 scope，父 scope 可组合嵌套', () => {
    const segment = {
      kind: 'iteration_item' as const,
      ownerOccurrenceId: 'A',
      ownerNodeRunId: 'A-run1',
      slot: 'body',
      index: 2,
    };
    const outer = deriveChildScope('root', segment);
    expect(deriveChildScope('root', { ...segment, ownerNodeRunId: 'A-run2' })).not.toBe(outer);
    const inner = deriveChildScope(outer, {
      ...segment,
      ownerOccurrenceId: 'B',
      ownerNodeRunId: 'B-run1',
      index: 5,
    });
    expect(inner).not.toBe(
      deriveChildScope('root', {
        ...segment,
        ownerOccurrenceId: 'B',
        ownerNodeRunId: 'B-run1',
        index: 5,
      }),
    );
  });
});
