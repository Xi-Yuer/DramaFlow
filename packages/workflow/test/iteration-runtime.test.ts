import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { z } from 'zod';
import {
  ImageType,
  NumberType,
  ROOT_EXECUTION_SCOPE_KEY,
  StringType,
  type NodeDefinition,
  type RuntimeValue,
} from '@dramaflow/contracts';
import {
  DefaultWorkflowOutputResolver,
  WorkflowPublishValidationError,
  createHumanReviewNodeType,
  createIfNodeType,
  deriveChildScope,
  iterationRecursionLimit,
  workflowStateSchema,
} from '../src/index.js';
import { FRAME, INVOCATION } from '../src/compiler/iteration/state.js';
import { arrayType, iterationRuntimeFixture } from './iteration-runtime-fixture.js';

const numberArray = arrayType(NumberType);
const nestedNumberArray = arrayType(numberArray);
const inlineNumbers = (value: number[]): RuntimeValue => ({
  storage: 'inline',
  type: numberArray,
  value,
});

describe('正式 Iteration Send + body subgraph', () => {
  it.each([0, 1, 10, 100])(
    '%i items 完整、有序且隔离，实际 occurrence / attempt 正确',
    async (count) => {
      const f = iterationRuntimeFixture(count);
      const compiled = await f.createCompiler().compile(f.definition, f.run);
      const result = workflowStateSchema.parse(await compiled.invoke(f.initial(), f.config));
      const iteration = result.outputs.iteration!;
      expect(iteration.result).toEqual(
        inlineNumbers(Array.from({ length: count }, (_, index) => index * 2 + 1)),
      );
      expect(iteration.text).toEqual({
        storage: 'inline',
        type: arrayType(StringType),
        value: Array.from({ length: count }, (_, index) => `style:${index}`),
      });
      expect(iteration.list).toEqual({
        storage: 'inline',
        type: nestedNumberArray,
        value: Array.from({ length: count }, (_, index) => [index, index]),
      });
      expect(Object.keys(iteration).sort()).toEqual(['list', 'result', 'text']);
      expect(Object.keys(result.outputs).sort()).toEqual(['consumer', 'iteration']);
      expect(result).not.toHaveProperty(FRAME);
      expect(result).not.toHaveProperty(INVOCATION);
      expect(f.execute).toHaveBeenCalledTimes(count);
      const rows = f.nodeRuns.getRecords().filter((row) => row.nodeId === 'process');
      expect(rows).toHaveLength(count);
      expect(new Set(rows.map((row) => row.occurrenceId)).size).toBe(count);
      expect(new Set(rows.map((row) => row.scopeKey)).size).toBe(count);
      expect(rows.every((row) => row.attempt === 1)).toBe(true);
      expect(f.nodeRuns.getRecords().filter((row) => row.nodeId === 'iteration')).toMatchObject([
        { attempt: 1, status: 'completed' },
      ]);
      const children = f.nodeRuns.getItemRecords();
      expect(children).toHaveLength(count);
      expect(new Set(children.map((child) => child.id)).size).toBe(count);
      expect(children.map((child) => Number(child.metadata.index)).sort((a, b) => a - b)).toEqual(
        Array.from({ length: count }, (_, index) => index),
      );
      for (const child of children) {
        expect(child.kind).toBe('iteration_item');
        expect(child.invocationKey).toBe(`iteration-item:${child.metadata.index}`);
        expect(rows.find((row) => row.childExecutionId === child.id)).toBeDefined();
      }
      const owner = f.nodeRuns.getOrCreateOccurrence.mock.calls
        .map((call) => call[0])
        .find((input) => input.nodeId === 'iteration');
      expect(owner).toMatchObject({ scopeKey: ROOT_EXECUTION_SCOPE_KEY, nodeId: 'iteration' });
      expect(rows.map((row) => row.scopeKey).sort()).toEqual(
        Array.from({ length: count }, (_, index) =>
          deriveChildScope(ROOT_EXECUTION_SCOPE_KEY, {
            kind: 'iteration_item',
            ownerOccurrenceId: 'occurrence-1',
            ownerNodeRunId: 'node-run-1',
            slot: 'body',
            index,
          }),
        ).sort(),
      );
      const outputs = new DefaultWorkflowOutputResolver().resolve(f.definition, result);
      expect(outputs.sum).toEqual({
        storage: 'inline',
        type: NumberType,
        value: count * count,
      });
      expect(outputs.answers).toEqual(iteration.result);
      for (const record of f.records) {
        expect(Object.keys(record.state.inputs).sort()).toEqual(['item', 'position']);
        expect(record.state.outputs).toEqual({});
        expect(record.state).not.toHaveProperty(FRAME);
      }
    },
  );

  it('body 完成顺序不同，聚合仍按 snapshot index', async () => {
    const count = 5;
    const f = iterationRuntimeFixture(count, { delay: true });
    const compiled = await f.createCompiler().compile(f.definition, f.run);
    const result = workflowStateSchema.parse(await compiled.invoke(f.initial(), f.config));
    expect(f.finished).toEqual([4, 3, 2, 1, 0]);
    expect(result.outputs.iteration!.result).toEqual(
      inlineNumbers(Array.from({ length: count }, (_, index) => index * 2 + 1)),
    );
  });

  it('reference 元素保持引用，snapshot 不读取容器，聚合不展开', async () => {
    const f = iterationRuntimeFixture(2);
    const image = (id: string): RuntimeValue => ({
      storage: 'reference',
      type: ImageType,
      reference: { kind: 'artifact', id },
    });
    f.registry.register({
      manifest: {
        type: 'test.iteration_image',
        version: 1,
        executionKind: 'action',
        metadata: { name: '图片', category: 'data' },
        inputs: [{ key: 'item', name: '图片', dataType: ImageType, required: true }],
        outputs: [{ key: 'label', name: '标记', dataType: StringType }],
        config: [],
      },
      inputSchema: z.object({ item: z.object({ label: z.string() }).strict() }).strict(),
      outputSchema: z.object({ label: z.string() }).strict(),
      configSchema: z.object({}).strict(),
      execute: async (input: { item: { label: string } }) => ({ label: input.item.label }),
    });
    const elements = [image('img-0'), image('img-1')];
    f.loop.inputs = { items: { type: 'workflow_input', key: 'items' } };
    f.loop.composite = {
      kind: 'iteration',
      itemType: ImageType,
      invariantInputs: [],
      bodyInputMapping: [{ target: 'item', source: { type: 'current_item' } }],
      body: {
        inputs: [{ name: 'item', type: ImageType, required: true }],
        nodes: [
          {
            id: 'show',
            type: 'test.iteration_image',
            typeVersion: 1,
            name: '显示',
            inputs: { item: { type: 'workflow_input', key: 'item' } },
            config: {},
            ui: { position: { x: 0, y: 0 } },
          },
        ],
        edges: [],
        outputs: [
          { name: 'label', type: StringType, source: { nodeId: 'show', outputKey: 'label' } },
        ],
      },
    };
    f.definition.inputs = [{ name: 'items', type: arrayType(ImageType), required: true }];
    f.definition.nodes = [f.loop];
    f.definition.edges = [];
    f.definition.outputs = [
      {
        name: 'labels',
        type: arrayType(StringType),
        source: { nodeId: 'iteration', outputKey: 'label' },
      },
    ];
    f.run.inputs = {
      items: { storage: 'collection', type: arrayType(ImageType), elements },
    };
    f.resolve.mockImplementation(async (reference) => ({ label: reference.id }));
    const compiled = await f.createCompiler().compile(f.definition, f.run);
    const result = workflowStateSchema.parse(await compiled.invoke(f.initial(), f.config));
    expect(f.resolve).toHaveBeenCalledTimes(2);
    expect(f.write).not.toHaveBeenCalled();
    const shown = f.nodeRuns.getRecords().filter((row) => row.nodeId === 'show');
    expect(shown.map((row) => row.inputs?.item)).toEqual(elements);
    expect(result.outputs.iteration!.label).toEqual({
      storage: 'inline',
      type: arrayType(StringType),
      value: ['img-0', 'img-1'],
    });
    expect(Object.keys(result.outputs)).toEqual(['iteration']);
    expect(new DefaultWorkflowOutputResolver().resolve(f.definition, result).labels).toEqual(
      result.outputs.iteration!.label,
    );
  });

  it('引用输出按 index 聚合成 collection，不内联成扁平数组', async () => {
    const f = iterationRuntimeFixture(3);
    f.registry.register({
      manifest: {
        type: 'test.iteration_emit_image',
        version: 1,
        executionKind: 'action',
        metadata: { name: '出图', category: 'data' },
        inputs: [{ key: 'index', name: '位置', dataType: NumberType, required: true }],
        outputs: [
          {
            key: 'image',
            name: '图片',
            dataType: ImageType,
            storagePolicy: 'reference',
          },
        ],
        config: [],
      },
      inputSchema: z.object({ index: z.number() }).strict(),
      outputSchema: z.object({ image: z.object({ index: z.number() }).strict() }).strict(),
      configSchema: z.object({}).strict(),
      execute: async (input: { index: number }) => ({ image: { index: input.index } }),
    });
    f.loop.inputs = { items: { type: 'workflow_input', key: 'items' } };
    f.write.mockImplementation(async (value) => ({
      kind: 'artifact',
      id: `img-${(value as { index: number }).index}`,
    }));
    f.loop.composite = {
      kind: 'iteration',
      itemType: NumberType,
      invariantInputs: [],
      bodyInputMapping: [{ target: 'index', source: { type: 'current_index' } }],
      body: {
        inputs: [{ name: 'index', type: NumberType, required: true }],
        nodes: [
          {
            id: 'emit',
            type: 'test.iteration_emit_image',
            typeVersion: 1,
            name: '出图',
            inputs: { index: { type: 'workflow_input', key: 'index' } },
            config: {},
            ui: { position: { x: 0, y: 0 } },
          },
        ],
        edges: [],
        outputs: [
          { name: 'image', type: ImageType, source: { nodeId: 'emit', outputKey: 'image' } },
        ],
      },
    };
    f.definition.nodes = [f.loop];
    f.definition.edges = [];
    f.definition.outputs = [
      {
        name: 'images',
        type: arrayType(ImageType),
        source: { nodeId: 'iteration', outputKey: 'image' },
      },
    ];
    const compiled = await f.createCompiler().compile(f.definition, f.run);
    const result = workflowStateSchema.parse(await compiled.invoke(f.initial(), f.config));
    expect(result.outputs.iteration!.image).toEqual({
      storage: 'collection',
      type: arrayType(ImageType),
      elements: [0, 1, 2].map((index) => ({
        storage: 'reference',
        type: ImageType,
        reference: { kind: 'artifact', id: `img-${index}` },
      })),
    });
  });

  it('DataEdge 与 Template 在 body 内按局部输入解析，父状态不可见', async () => {
    const f = iterationRuntimeFixture(2);
    f.definition.inputs.push({ name: 'label', type: StringType, required: true });
    f.run.inputs.label = { storage: 'inline', type: StringType, value: '剧' };
    f.loop.inputs = {
      items: { type: 'workflow_input', key: 'items' },
      label: { type: 'workflow_input', key: 'label' },
    };
    f.loop.composite = {
      kind: 'iteration',
      itemType: NumberType,
      invariantInputs: [{ name: 'label', type: StringType, required: true }],
      bodyInputMapping: [
        { target: 'item', source: { type: 'current_item' } },
        { target: 'position', source: { type: 'current_index' } },
        { target: 'label', source: { type: 'iteration_input', key: 'label' } },
      ],
      body: {
        inputs: [
          { name: 'item', type: NumberType, required: true },
          { name: 'position', type: NumberType, required: true },
          { name: 'label', type: StringType, required: true },
        ],
        nodes: [
          {
            ...f.bodyNode('draft'),
            inputs: {
              value: { type: 'workflow_input', key: 'item' },
              index: { type: 'workflow_input', key: 'position' },
            },
          },
          {
            ...f.bodyNode('render'),
            inputs: {
              index: { type: 'workflow_input', key: 'position' },
              caption: {
                type: 'template',
                value: '{{line}}-{{label}}',
                variables: {
                  line: { type: 'node_output', nodeId: 'draft', portKey: 'text' },
                  label: { type: 'workflow_input', key: 'label' },
                },
              },
            },
          },
        ],
        edges: [
          {
            id: 'draft-value',
            kind: 'data',
            source: { nodeId: 'draft', portKey: 'result' },
            target: { nodeId: 'render', portKey: 'value' },
          },
        ],
        outputs: [
          { name: 'result', type: NumberType, source: { nodeId: 'render', outputKey: 'result' } },
          { name: 'text', type: StringType, source: { nodeId: 'render', outputKey: 'text' } },
        ],
      },
    };
    f.definition.nodes = [f.loop];
    f.definition.edges = [];
    f.definition.outputs = [];
    const compiled = await f.createCompiler().compile(f.definition, f.run);
    const result = workflowStateSchema.parse(await compiled.invoke(f.initial(), f.config));
    expect(f.execute).toHaveBeenCalledTimes(4);
    expect(result.outputs.iteration).toEqual({
      result: inlineNumbers([3, 7]),
      text: {
        storage: 'inline',
        type: arrayType(StringType),
        value: ['style:0-剧', 'style:1-剧'],
      },
    });
    expect(Object.keys(result.outputs)).toEqual(['iteration']);
    expect(
      f.records.every((record) =>
        Object.keys(record.state.outputs).every((id) => id !== 'iteration'),
      ),
    ).toBe(true);
  });

  it('并行 Action body 分别聚合，不把局部输出写进父 State', async () => {
    const f = iterationRuntimeFixture(2);
    f.loop.composite!.body.nodes = [f.bodyNode('left'), f.bodyNode('right')];
    f.loop.composite!.body.outputs = [
      { name: 'left', type: NumberType, source: { nodeId: 'left', outputKey: 'result' } },
      { name: 'right', type: NumberType, source: { nodeId: 'right', outputKey: 'result' } },
    ];
    f.definition.nodes = [f.loop];
    f.definition.edges = [];
    f.definition.outputs = [];
    const compiled = await f.createCompiler().compile(f.definition, f.run);
    const result = workflowStateSchema.parse(await compiled.invoke(f.initial(), f.config));
    expect(f.execute).toHaveBeenCalledTimes(4);
    expect(result.outputs.iteration).toEqual({
      left: inlineNumbers([1, 3]),
      right: inlineNumbers([1, 3]),
    });
    expect(result.outputs.left).toBeUndefined();
    expect(result.outputs.right).toBeUndefined();
  });

  it('上游节点输出保留，Iteration 只回写自己的聚合增量', async () => {
    const f = iterationRuntimeFixture(2);
    f.registry.register({
      manifest: {
        type: 'test.iteration_source',
        version: 1,
        executionKind: 'action',
        metadata: { name: '来源', category: 'data' },
        inputs: [],
        outputs: [{ key: 'tag', name: '标记', dataType: StringType }],
        config: [],
      },
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ tag: z.string() }).strict(),
      configSchema: z.object({}).strict(),
      execute: async () => ({ tag: 'ready' }),
    });
    f.definition.nodes.unshift({
      id: 'source',
      type: 'test.iteration_source',
      typeVersion: 1,
      name: '来源',
      inputs: {},
      config: {},
      ui: { position: { x: 0, y: 0 } },
    });
    f.definition.edges.unshift({
      id: 'before',
      kind: 'control',
      source: { nodeId: 'source' },
      target: { nodeId: 'iteration' },
    });
    const compiled = await f.createCompiler().compile(f.definition, f.run);
    const result = workflowStateSchema.parse(await compiled.invoke(f.initial(), f.config));
    expect(result.outputs.source).toEqual({
      tag: { storage: 'inline', type: StringType, value: 'ready' },
    });
    expect(result.outputs.iteration!.result).toEqual(inlineNumbers([1, 3]));
    expect(result.outputs.consumer!.sum).toEqual({
      storage: 'inline',
      type: NumberType,
      value: 4,
    });
  });

  it('body 链深度超过父图静态预算时仍完成，预算不随 item 数增长', async () => {
    const depth = 8;
    const f = iterationRuntimeFixture(3);
    f.registry.register({
      manifest: {
        type: 'test.iteration_hop',
        version: 1,
        executionKind: 'action',
        metadata: { name: '递进', category: 'data' },
        inputs: [{ key: 'value', name: '值', dataType: NumberType, required: true }],
        outputs: [{ key: 'value', name: '值', dataType: NumberType }],
        config: [],
      },
      inputSchema: z.object({ value: z.number() }).strict(),
      outputSchema: z.object({ value: z.number() }).strict(),
      configSchema: z.object({}).strict(),
      execute: async (input: { value: number }) => ({ value: input.value + 1 }),
    });
    const nodes: NodeDefinition[] = [];
    for (let index = 0; index < depth; index += 1) {
      const step: NodeDefinition = {
        id: `step${index}`,
        type: 'test.iteration_hop',
        typeVersion: 1,
        name: `步骤${index}`,
        inputs: {},
        config: {},
        ui: { position: { x: 0, y: index } },
      };
      if (index === 0) step.inputs = { value: { type: 'workflow_input', key: 'item' } };
      nodes.push(step);
    }
    f.loop.inputs = { items: { type: 'workflow_input', key: 'items' } };
    f.loop.composite = {
      kind: 'iteration',
      itemType: NumberType,
      invariantInputs: [],
      bodyInputMapping: [{ target: 'item', source: { type: 'current_item' } }],
      body: {
        inputs: [{ name: 'item', type: NumberType, required: true }],
        nodes,
        edges: nodes.slice(1).map((node, index) => ({
          id: `hop-${index}`,
          kind: 'data' as const,
          source: { nodeId: `step${index}`, portKey: 'value' },
          target: { nodeId: node.id, portKey: 'value' },
        })),
        outputs: [
          {
            name: 'value',
            type: NumberType,
            source: { nodeId: `step${depth - 1}`, outputKey: 'value' },
          },
        ],
      },
    };
    f.definition.nodes = [f.loop];
    f.definition.edges = [];
    f.definition.outputs = [];
    const limit = iterationRecursionLimit(f.loop);
    expect(limit).toBeGreaterThan(2);
    expect(limit).toBeLessThan(depth * 3);
    const compiled = await f.createCompiler().compile(f.definition, f.run);
    const result = workflowStateSchema.parse(await compiled.invoke(f.initial(), f.config));
    expect(result.outputs.iteration!.value).toEqual(inlineNumbers([8, 9, 10]));
  });

  it('checkpoint 保存 collection snapshot 与 item scope，重建后不重读容器也不重放 Action', async () => {
    const f = iterationRuntimeFixture(3);
    const saver = new MemorySaver();
    f.run.inputs.items = {
      storage: 'reference',
      type: numberArray,
      reference: { kind: 'artifact', id: 'container' },
    };
    f.resolve.mockResolvedValue([0, 1, 2]);
    const compiled = await f.createCompiler(saver).compile(f.definition, f.run);
    await compiled.invoke(f.initial(), {
      ...f.config,
      ...{ interruptBefore: ['consumer'] },
    });
    expect(f.resolve).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(3);
    const paused = await compiled.getState(f.config);
    expect(paused.next).toEqual(['consumer']);
    const frames: RuntimeValue[] = [];
    const scopes: string[] = [];
    for await (const tuple of saver.list({ configurable: { thread_id: f.run.threadId } })) {
      const values = JSON.parse(JSON.stringify(tuple.checkpoint.channel_values)) as Record<
        string,
        unknown
      >;
      const frame = values[FRAME] as
        { snapshot?: RuntimeValue; ownerOccurrenceId?: string } | undefined;
      if (frame?.snapshot) frames.push(frame.snapshot);
      const invocation = values[INVOCATION] as { scopeKey?: string; index?: number } | undefined;
      if (invocation?.scopeKey) scopes.push(invocation.scopeKey);
    }
    expect(frames.length).toBeGreaterThan(0);
    for (const snapshot of frames) {
      expect(snapshot).toMatchObject({
        storage: 'collection',
        elements: [0, 1, 2].map((value) => ({ storage: 'inline', value })),
      });
    }
    expect([...new Set(scopes)].sort()).toEqual(
      [0, 1, 2]
        .map((index) =>
          deriveChildScope(ROOT_EXECUTION_SCOPE_KEY, {
            kind: 'iteration_item',
            ownerOccurrenceId: 'occurrence-1',
            ownerNodeRunId: 'node-run-1',
            slot: 'body',
            index,
          }),
        )
        .sort(),
    );
    f.resolve.mockRejectedValue(new Error('恢复不能重新读取容器'));
    const restored = await f.createCompiler(saver).compile(f.definition, f.run);
    const result = workflowStateSchema.parse(await restored.invoke(null, f.config));
    expect(result.outputs.iteration!.result).toEqual(inlineNumbers([1, 3, 5]));
    expect(result.outputs.consumer!.sum).toEqual({
      storage: 'inline',
      type: NumberType,
      value: 9,
    });
    expect(f.resolve).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(3);
    const process = f.nodeRuns.getRecords().filter((row) => row.nodeId === 'process');
    expect(process).toHaveLength(3);
    expect(process.every((row) => row.attempt === 1)).toBe(true);
  });

  it('1.5.0 maxConcurrency=1 在任何节点执行前 fail-fast，不改成 2', async () => {
    const f = iterationRuntimeFixture(10);
    const compiled = await f.createCompiler().compile(f.definition, f.run);
    const config = { ...f.config, maxConcurrency: 1 };
    await expect(compiled.invoke(f.initial(), config)).rejects.toMatchObject({
      code: 'ITERATION_LANGGRAPH_CONCURRENCY_UNSUPPORTED',
    });
    expect(config.maxConcurrency).toBe(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.nodeRuns.getRecords()).toEqual([]);
  });

  it.each([
    ['flow.if', createIfNodeType],
    ['flow.human_review', createHumanReviewNodeType],
    ['flow.iteration', undefined],
  ] as const)('body 中的 %s 在执行前拒绝', async (type, create) => {
    const f = iterationRuntimeFixture(1);
    if (create) f.registry.register(create());
    f.loop.composite!.body.nodes = [
      {
        id: 'blocked',
        type,
        typeVersion: 1,
        name: '不允许',
        inputs: {},
        config: {},
        ui: { position: { x: 0, y: 0 } },
      },
    ];
    f.loop.composite!.body.outputs = [
      { name: 'result', type: NumberType, source: { nodeId: 'blocked', outputKey: 'result' } },
    ];
    await expect(f.createCompiler().compile(f.definition, f.run)).rejects.toBeInstanceOf(
      WorkflowPublishValidationError,
    );
    await expect(f.createCompiler().compile(f.definition, f.run)).rejects.toMatchObject({
      code: 'ITERATION_BODY_CAPABILITY_UNSUPPORTED',
    });
    expect(f.execute).not.toHaveBeenCalled();
  });
});
