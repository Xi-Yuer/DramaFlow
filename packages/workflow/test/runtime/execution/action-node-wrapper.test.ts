import { nodeRunRepositoryFixture } from '../../fixtures/node-run-fixture.js';
import { END, START, StateGraph } from '@langchain/langgraph';
import {
  NumberType,
  type NodeDefinition,
  type NodeTypeManifest,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ActionNodeCompilationStrategy,
  createBindingResolver,
  DefaultDataStoragePolicyResolver,
  DefaultNodeExecutor,
  DefaultRuntimeValueCodec,
  DependencyCompiler,
  NodeRegistry,
  WorkflowStateAnnotation,
  type ArtifactWriter,
  type DataReferenceResolver,
  type LangGraphNode,
  type NodeExecutionContext,
  type WorkflowState,
} from '../../../src/index.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function parallelFixture() {
  const gates = { A: deferred(), B: deferred() };
  const started = { A: deferred(), B: deferred() };
  const finished = { A: deferred(), B: deferred() };
  const completionOrder: string[] = [];
  const source = (id: 'A' | 'B', value: number) => ({
    manifest: {
      type: id === 'A' ? 'test.source_a' : 'test.source_b',
      version: 1,
      executionKind: 'action',
      metadata: { name: id, category: 'data' },
      inputs: [],
      outputs: [{ key: 'value', name: '值', dataType: NumberType }],
      config: [],
    } satisfies NodeTypeManifest,
    inputSchema: z.object({}).strict(),
    configSchema: z.object({}).strict(),
    outputSchema: z.object({ value: z.number() }).strict(),
    execute: vi.fn(async () => {
      started[id].resolve();
      await gates[id].promise;
      completionOrder.push(id);
      finished[id].resolve();
      return { value };
    }),
  });
  const a = source('A', 10);
  const b = source('B', 20);
  const executeC = vi.fn(
    async (
      input: { left: number; right: number },
      _config: unknown,
      context: NodeExecutionContext,
    ) => {
      expect(context.state.outputs.A).toEqual({
        value: { storage: 'inline', type: NumberType, value: 10 },
      });
      expect(context.state.outputs.B).toEqual({
        value: { storage: 'inline', type: NumberType, value: 20 },
      });
      expect(Object.hasOwn(context.state.outputs, 'C')).toBe(false);
      return { sum: input.left + input.right };
    },
  );
  const c = {
    manifest: {
      type: 'test.sum',
      version: 1,
      executionKind: 'action',
      metadata: { name: '求和', category: 'data' },
      inputs: [
        { key: 'left', name: '左值', dataType: NumberType },
        { key: 'right', name: '右值', dataType: NumberType },
      ],
      outputs: [{ key: 'sum', name: '和', dataType: NumberType }],
      config: [],
    } satisfies NodeTypeManifest,
    inputSchema: z.object({ left: z.number(), right: z.number() }).strict(),
    configSchema: z.object({}).strict(),
    outputSchema: z.object({ sum: z.number() }).strict(),
    execute: executeC,
  };
  const node = (id: string, type: string): NodeDefinition => ({
    id,
    type,
    typeVersion: 1,
    name: id,
    inputs: {},
    config: {},
    ui: { position: { x: 0, y: 0 } },
  });
  const nodes = [
    node('A', a.manifest.type),
    node('B', b.manifest.type),
    node('C', c.manifest.type),
  ];
  const workflow: WorkflowDefinition = {
    nodes,
    inputs: [],
    outputs: [],
    edges: [
      {
        id: 'a-c',
        kind: 'data',
        source: { nodeId: 'A', portKey: 'value' },
        target: { nodeId: 'C', portKey: 'left' },
      },
      {
        id: 'b-c',
        kind: 'data',
        source: { nodeId: 'B', portKey: 'value' },
        target: { nodeId: 'C', portKey: 'right' },
      },
      { id: 'a-c-control', kind: 'control', source: { nodeId: 'A' }, target: { nodeId: 'C' } },
    ],
  };
  const registry = new NodeRegistry([a, b, c]);
  const bindings = createBindingResolver();
  const resolveInputs = vi.spyOn(bindings, 'resolveInputs');
  const write = vi
    .fn<ArtifactWriter['write']>()
    .mockRejectedValue(new Error('数值不应创建 Artifact'));
  const resolve = vi
    .fn<DataReferenceResolver['resolve']>()
    .mockRejectedValue(new Error('inline 不应读取引用'));
  const executor = new DefaultNodeExecutor(
    registry,
    bindings,
    new DefaultRuntimeValueCodec({ resolve }, { write }, new DefaultDataStoragePolicyResolver()),
    nodeRunRepositoryFixture(),
  );
  const strategy = new ActionNodeCompilationStrategy();
  const wrapped = new Map<string, LangGraphNode>();
  for (const definition of nodes)
    strategy.compile({
      node: definition,
      manifest: registry.get(definition.type, definition.typeVersion).manifest,
      executor,
      executionContext: (config) => ({ scopeKey: 'root', workflow, runnableConfig: config }),
      addNode: (id, action) => {
        wrapped.set(id, action);
      },
    });
  const graph = new StateGraph(WorkflowStateAnnotation)
    .addNode<string>('A', wrapped.get('A')!)
    .addNode('B', wrapped.get('B')!)
    .addNode('C', wrapped.get('C')!)
    .addEdge(START, 'A')
    .addEdge(START, 'B')
    .addEdge('C', END);
  new DependencyCompiler().compile({
    edges: workflow.edges,
    addEdge: (from, to) => {
      graph.addEdge(from, to);
    },
  });
  const initial: WorkflowState = {
    run: {
      projectId: 'project',
      workflowId: 'workflow',
      workflowVersionId: 'version',
      workflowRunId: 'run',
    },
    inputs: {},
    outputs: { seed: { value: { storage: 'inline', type: NumberType, value: 1 } } },
    variables: {},
    execution: {},
  };
  return {
    graph,
    initial,
    gates,
    started,
    finished,
    completionOrder,
    executeC,
    resolveInputs,
    write,
    resolve,
  };
}

describe('Action Wrapper → WorkflowState.outputs', () => {
  it.each([
    ['A', 'B'],
    ['B', 'A'],
  ] as const)(
    '%s 先完成：并行结果完整合并，C 经真实 BindingResolver 读取 A/B 后只执行一次',
    async (first, second) => {
      const f = parallelFixture();
      const snapshot = structuredClone(f.initial);
      expect([...f.graph.waitingEdges]).toEqual([[['A', 'B'], 'C']]);
      const invocation = f.graph.compile().invoke(f.initial);
      try {
        await Promise.all([f.started.A.promise, f.started.B.promise]);
        f.gates[first].resolve();
        await f.finished[first].promise;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(f.completionOrder).toEqual([first]);
        expect(f.executeC).not.toHaveBeenCalled();
        f.gates[second].resolve();
        const result = await invocation;
        expect(f.executeC).toHaveBeenCalledTimes(1);
        expect(f.executeC.mock.calls[0]?.[0]).toEqual({ left: 10, right: 20 });
        const bindingContext = f.resolveInputs.mock.calls.find(
          ([context]) => context.node.id === 'C',
        )?.[0];
        expect(bindingContext?.state.outputs).toEqual({
          seed: f.initial.outputs.seed,
          A: { value: { storage: 'inline', type: NumberType, value: 10 } },
          B: { value: { storage: 'inline', type: NumberType, value: 20 } },
        });
        expect(result.outputs).toEqual({
          ...bindingContext?.state.outputs,
          C: { sum: { storage: 'inline', type: NumberType, value: 30 } },
        });
        expect(result.run).toEqual(f.initial.run);
        expect(result.inputs).toEqual(f.initial.inputs);
        expect(result.variables).toEqual(f.initial.variables);
        expect(result.execution).toEqual(f.initial.execution);
        expect(f.initial).toEqual(snapshot);
        expect(f.write).not.toHaveBeenCalled();
        expect(f.resolve).not.toHaveBeenCalled();
      } finally {
        f.gates.A.resolve();
        f.gates.B.resolve();
        await invocation;
      }
    },
  );
});
