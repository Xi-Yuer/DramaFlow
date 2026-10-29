import { createFormatTextNodeType } from './format-text.js';
import { vi } from 'vitest';
import { z } from 'zod';
import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph';
import {
  StringType,
  NumberType,
  type GraphDefinition,
  type NodeDefinition,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@dramaflow/contracts';
import {
  createSubworkflowNodeType,
  createIterationNodeType,
  createIfNodeType,
  createHumanReviewNodeType,
  NodeRegistry,
  DefaultWorkflowCompiler,
  DefaultNodeExecutor,
  DefaultRuntimeValueCodec,
  DefaultDataStoragePolicyResolver,
  createBindingResolver,
  type ArtifactWriter,
  type DataReferenceResolver,
  type NodeExecutor,
  type WorkflowState,
} from '../../src/index.js';
import { auditedNodeRunRepositoryFixture } from './node-run-fixture.js';
type SubworkflowRuntimeFixture = {
  registry: NodeRegistry;
  child: GraphDefinition;
  parent: NodeDefinition;
  definition: WorkflowDefinition;
  run: WorkflowRun;
  nodeRuns: ReturnType<typeof auditedNodeRunRepositoryFixture>;
  codec: DefaultRuntimeValueCodec;
  bindings: ReturnType<typeof createBindingResolver>;
  useExecutor(execute: NodeExecutor['execute']): void;
  createCompiler(saver?: BaseCheckpointSaver): DefaultWorkflowCompiler;
  resolve: DataReferenceResolver['resolve'];
  write: ArtifactWriter['write'];
  initial(): WorkflowState;
  config: { configurable: { thread_id: string } };
};
export function format(id = 'format', index = 1): NodeDefinition {
  return {
    id,
    type: 'test.format_text',
    typeVersion: 1,
    name: id,
    inputs: {
      text: { type: 'workflow_input', key: 'text' },
      index: { type: 'constant', value: index },
    },
    config: { template: '{{text}}-{{index}}' },
    ui: { position: { x: 0, y: 0 } },
  };
}
export function subworkflowRuntimeFixture(): SubworkflowRuntimeFixture {
  const registry = new NodeRegistry([
    createSubworkflowNodeType(),
    createFormatTextNodeType(),
    createIterationNodeType(),
    createIfNodeType(),
    createHumanReviewNodeType(),
    {
      manifest: {
        type: 'test.join',
        version: 1,
        executionKind: 'action',
        metadata: { name: '汇聚', category: 'data' },
        inputs: [
          { key: 'a', name: 'A', dataType: StringType, required: true },
          { key: 'b', name: 'B', dataType: StringType, required: true },
        ],
        outputs: [{ key: 'text', name: '文本', dataType: StringType }],
        config: [],
      },
      inputSchema: z.object({ a: z.string(), b: z.string() }),
      outputSchema: z.object({ text: z.string() }),
      configSchema: z.object({}),
      execute: async (input: { a: string; b: string }) => ({ text: `${input.a}|${input.b}` }),
    },
    {
      manifest: {
        type: 'test.number',
        version: 1,
        executionKind: 'action',
        metadata: { name: '数字', category: 'data' },
        inputs: [],
        outputs: [{ key: 'value', name: '值', dataType: NumberType }],
        config: [],
      },
      inputSchema: z.object({}),
      outputSchema: z.object({ value: z.number() }),
      configSchema: z.object({}),
      execute: async () => ({ value: 2 }),
    },
  ]);
  const child: GraphDefinition = {
    inputs: [{ name: 'text', type: StringType, required: true }],
    nodes: [format()],
    edges: [],
    outputs: [{ name: 'text', type: StringType, source: { nodeId: 'format', outputKey: 'text' } }],
  };
  const parent: NodeDefinition = {
    id: 'sub',
    type: 'flow.subworkflow',
    typeVersion: 1,
    name: '子流程',
    inputs: { text: { type: 'workflow_input', key: 'text' } },
    config: {},
    ui: { position: { x: 0, y: 0 } },
    composite: { kind: 'subworkflow', graph: child },
  };
  const definition: WorkflowDefinition = {
    inputs: [{ name: 'text', type: StringType, required: true }],
    nodes: [parent],
    edges: [],
    outputs: [{ name: 'result', type: StringType, source: { nodeId: 'sub', outputKey: 'text' } }],
  };
  const run: WorkflowRun = {
    id: 'run',
    projectId: 'project',
    workflowId: 'workflow',
    workflowVersionId: 'version',
    threadId: 'thread',
    invocationKey: 'invoke',
    status: 'running',
    inputs: { text: { storage: 'inline', type: StringType, value: 'A' } },
    createdAt: '2026-10-26T00:00:00.000Z',
  };
  const nodeRuns = auditedNodeRunRepositoryFixture();
  const resolve = vi
    .fn<DataReferenceResolver['resolve']>()
    .mockRejectedValue(new Error('不应物化引用'));
  const write = vi
    .fn<ArtifactWriter['write']>()
    .mockResolvedValue({ kind: 'artifact', id: 'output-reference' });
  const codec = new DefaultRuntimeValueCodec(
    { resolve },
    { write },
    new DefaultDataStoragePolicyResolver(),
  );
  const bindings = createBindingResolver();
  const createExecutor = vi.fn(
    async () => new DefaultNodeExecutor(registry, bindings, codec, nodeRuns),
  );
  function useExecutor(execute: NodeExecutor['execute']): void {
    createExecutor.mockResolvedValue({ execute } as never);
  }
  const createCompiler = (saver: BaseCheckpointSaver = new MemorySaver()) =>
    new DefaultWorkflowCompiler(
      registry,
      createExecutor,
      saver,
      async () => ({ bindings, codec }),
      async () => nodeRuns,
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
  return {
    registry,
    child,
    parent,
    definition,
    run,
    nodeRuns,
    codec,
    bindings,
    useExecutor,
    createCompiler,
    resolve,
    write,
    initial,
    config: { configurable: { thread_id: run.threadId } },
  };
}
