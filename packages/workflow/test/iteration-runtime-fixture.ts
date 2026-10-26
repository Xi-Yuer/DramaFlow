import { vi } from 'vitest';
import { z } from 'zod';
import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph';
import {
  NumberType,
  StringType,
  type NodeDefinition,
  type IterationCompositeDefinition,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@dramaflow/contracts';
import {
  createBindingResolver,
  createIterationNodeType,
  DefaultNodeExecutor,
  DefaultRuntimeValueCodec,
  DefaultDataStoragePolicyResolver,
  DefaultWorkflowCompiler,
  NodeRegistry,
  type NodeExecutionContext,
  type WorkflowState,
  type ArtifactWriter,
  type DataReferenceResolver,
} from '../src/index.js';
import { auditedNodeRunRepositoryFixture } from './node-run-fixture.js';

export const arrayType = (itemType: import('@dramaflow/contracts').DataType) => ({
  kind: 'array' as const,
  itemType,
});
export function iterationRuntimeFixture(count = 3, options?: { delay?: boolean }) {
  const records: { index: number; scopeKey: string; input: unknown; state: WorkflowState }[] = [];
  const finished: number[] = [];
  let active = 0;
  let peak = 0;
  const execute = vi.fn(
    async (
      input: { value: number; index: number; style?: string; caption?: string },
      config: { delay?: boolean },
      context: NodeExecutionContext,
    ) => {
      records.push({
        index: input.index,
        scopeKey: context.scopeKey,
        input,
        state: structuredClone(context.state),
      });
      active++;
      peak = Math.max(peak, active);
      if (config.delay)
        await new Promise((resolve) => setTimeout(resolve, (count - input.index + 1) * 20));
      active--;
      finished.push(input.index);
      return {
        result: input.value * 2 + 1,
        text: input.caption ?? `${input.style ?? 'style'}:${input.value}`,
        list: [input.value, input.index],
      };
    },
  );
  const processType = {
    manifest: {
      type: 'test.iteration_process',
      version: 1,
      executionKind: 'action' as const,
      metadata: { name: '处理', category: 'data' as const },
      inputs: [
        { key: 'value', name: '值', dataType: NumberType, required: true },
        { key: 'index', name: '位置', dataType: NumberType, required: true },
        { key: 'style', name: '风格', dataType: StringType, required: false },
        { key: 'caption', name: '说明', dataType: StringType, required: false },
      ],
      outputs: [
        { key: 'result', name: '值', dataType: NumberType },
        { key: 'text', name: '文本', dataType: StringType },
        {
          key: 'list',
          name: '数组',
          dataType: arrayType(NumberType),
          storagePolicy: 'inline' as const,
        },
      ],
      config: [{ key: 'delay', name: '延迟', type: 'boolean' as const }],
    },
    inputSchema: z
      .object({
        value: z.number(),
        index: z.number(),
        style: z.string().optional(),
        caption: z.string().optional(),
      })
      .strict(),
    configSchema: z.object({ delay: z.boolean().optional() }).strict(),
    outputSchema: z
      .object({ result: z.number(), text: z.string(), list: z.array(z.number()) })
      .strict(),
    execute,
  };
  const consume = vi.fn(async (input: { values: number[] }) => ({
    sum: input.values.reduce((a, b) => a + b, 0),
  }));
  const registry = new NodeRegistry([
    createIterationNodeType(),
    processType,
    {
      manifest: {
        type: 'test.iteration_consume',
        version: 1,
        executionKind: 'action',
        metadata: { name: '汇总', category: 'data' },
        inputs: [{ key: 'values', name: '数组', dataType: arrayType(NumberType), required: true }],
        outputs: [{ key: 'sum', name: '总数', dataType: NumberType }],
        config: [],
      },
      inputSchema: z.object({ values: z.array(z.number()) }),
      outputSchema: z.object({ sum: z.number() }),
      configSchema: z.object({}),
      execute: consume,
    },
  ]);
  const bodyNode = (id: string): NodeDefinition => ({
    id,
    type: 'test.iteration_process',
    typeVersion: 1,
    name: id,
    inputs: {
      value: { type: 'workflow_input', key: 'item' },
      index: { type: 'workflow_input', key: 'position' },
      style: { type: 'workflow_input', key: 'style' },
    },
    config: options?.delay ? { delay: true } : {},
    ui: { position: { x: 0, y: 0 } },
  });
  const loop: NodeDefinition & { composite: IterationCompositeDefinition } = {
    id: 'iteration',
    type: 'flow.iteration',
    typeVersion: 1,
    name: '逐项',
    inputs: {
      items: { type: 'workflow_input', key: 'items' },
      style: { type: 'workflow_input', key: 'style' },
    },
    config: {},
    ui: { position: { x: 0, y: 0 } },
    composite: {
      kind: 'iteration',
      itemType: NumberType,
      invariantInputs: [{ name: 'style', type: StringType, required: false }],
      bodyInputMapping: [
        { target: 'item', source: { type: 'current_item' } },
        { target: 'position', source: { type: 'current_index' } },
        { target: 'style', source: { type: 'iteration_input', key: 'style' } },
      ],
      body: {
        inputs: [
          { name: 'item', type: NumberType, required: true },
          { name: 'position', type: NumberType, required: true },
          { name: 'style', type: StringType, required: false },
        ],
        nodes: [bodyNode('process')],
        edges: [],
        outputs: [
          { name: 'result', type: NumberType, source: { nodeId: 'process', outputKey: 'result' } },
          { name: 'text', type: StringType, source: { nodeId: 'process', outputKey: 'text' } },
          {
            name: 'list',
            type: arrayType(NumberType),
            source: { nodeId: 'process', outputKey: 'list' },
          },
        ],
      },
    },
  };
  const definition: WorkflowDefinition = {
    inputs: [
      { name: 'items', type: arrayType(NumberType), required: true },
      { name: 'style', type: StringType, required: false },
    ],
    nodes: [
      loop,
      {
        id: 'consumer',
        type: 'test.iteration_consume',
        typeVersion: 1,
        name: '汇总',
        inputs: {},
        config: {},
        ui: { position: { x: 0, y: 0 } },
      },
    ],
    edges: [
      {
        id: 'aggregated',
        kind: 'data',
        source: { nodeId: 'iteration', portKey: 'result' },
        target: { nodeId: 'consumer', portKey: 'values' },
      },
    ],
    outputs: [
      {
        name: 'answers',
        type: arrayType(NumberType),
        source: { nodeId: 'iteration', outputKey: 'result' },
      },
      { name: 'sum', type: NumberType, source: { nodeId: 'consumer', outputKey: 'sum' } },
    ],
  };
  const run: WorkflowRun = {
    id: 'iteration-run',
    projectId: 'project',
    workflowId: 'workflow',
    workflowVersionId: 'version',
    threadId: `iteration-${crypto.randomUUID()}`,
    invocationKey: 'invoke',
    status: 'running',
    inputs: {
      items: {
        storage: 'inline',
        type: arrayType(NumberType),
        value: Array.from({ length: count }, (_, index) => index),
      },
    },
    createdAt: '2026-10-24T00:00:00.000Z',
  };
  const nodeRuns = auditedNodeRunRepositoryFixture();
  const resolve = vi
    .fn<DataReferenceResolver['resolve']>()
    .mockRejectedValue(new Error('不应解析引用'));
  const write = vi
    .fn<ArtifactWriter['write']>()
    .mockResolvedValue({ kind: 'artifact', id: 'output' });
  const codec = new DefaultRuntimeValueCodec(
    { resolve },
    { write },
    new DefaultDataStoragePolicyResolver(),
  );
  const bindings = createBindingResolver();
  const services = { bindings, codec };
  const createExecutor = vi.fn(
    async () => new DefaultNodeExecutor(registry, bindings, codec, nodeRuns),
  );
  const createCompiler = (saver: BaseCheckpointSaver = new MemorySaver()) =>
    new DefaultWorkflowCompiler(
      registry,
      createExecutor,
      saver,
      async () => services,
      async () => nodeRuns,
      async () => nodeRuns,
    );
  const initial = (): WorkflowState => ({
    run: {
      projectId: run.projectId,
      workflowId: run.workflowId,
      workflowVersionId: run.workflowVersionId,
      workflowRunId: run.id,
    },
    inputs: run.inputs,
    outputs: {},
    variables: {},
    execution: {},
  });
  const config = { configurable: { thread_id: run.threadId } };
  return {
    definition,
    loop,
    body: loop.composite!.body,
    run,
    nodeRuns,
    codec,
    resolve,
    write,
    bindings,
    registry,
    execute,
    consume,
    createCompiler,
    createExecutor,
    initial,
    config,
    records,
    finished,
    bodyNode,
    peak: () => peak,
  };
}
