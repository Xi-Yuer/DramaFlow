import { afterEach, describe, expect, it, vi } from 'vitest';
import { Annotation, StateGraph } from '@langchain/langgraph';
import {
  ActionNodeCompilationStrategy,
  DefaultNodeExecutor,
  WorkflowStateAnnotation,
  createSubworkflowNodeType,
  deriveChildScope,
  validateWorkflowForPublish,
  type GraphExecutionIdentity,
  type WorkflowState,
} from '../../../src/index.js';
import * as graphCompiler from '../../../src/compiler/graph/graph-compiler.js';
import { prepareGraphCompilation } from '../../../src/compiler/graph/compilation-plan.js';
import { IfNodeCompilationStrategy } from '../../../src/compiler/if/strategy.js';
import { HumanReviewNodeCompilationStrategy } from '../../../src/compiler/human-review/strategy.js';
import { IterationNodeCompilationStrategy } from '../../../src/compiler/iteration/strategy.js';
import { SubWorkflowNodeCompilationStrategy } from '../../../src/compiler/subworkflow/strategy.js';
import { SUBWORKFLOW_INVOCATION_KEY } from '../../../src/compiler/subworkflow/state.js';
import { subworkflowRuntimeFixture } from '../../fixtures/subworkflow-runtime-fixture.js';
import { iterationRuntimeFixture } from '../../fixtures/iteration-runtime-fixture.js';

const InvocationState = Annotation.Root({
  ...WorkflowStateAnnotation.spec,
  // 模拟调用图自己的私有通道，必须在原生 SubWorkflow 输入过滤前解析。
  invocation: Annotation<GraphExecutionIdentity>(),
});
type InvocationState = typeof InvocationState.State;
const stop = new Error('身份断言到此停止，不执行 SubWorkflow child graph');
const strategies = () => ({
  action: new ActionNodeCompilationStrategy(),
  if: new IfNodeCompilationStrategy(),
  review: new HumanReviewNodeCompilationStrategy(),
  iteration: new IterationNodeCompilationStrategy(),
  subworkflow: new SubWorkflowNodeCompilationStrategy(),
});
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const f = subworkflowRuntimeFixture();
  const resolve = vi.fn((state: InvocationState) => state.invocation);
  function compile(execution: graphCompiler.GraphExecutionContext<InvocationState> = { resolve }) {
    const plan = prepareGraphCompilation({
      definition: f.definition,
      definitionLocation: { workflowVersionId: f.run.workflowVersionId, path: [] },
      registry: f.registry,
      strategies: strategies(),
    });
    const builder = new StateGraph<
      typeof InvocationState.spec,
      InvocationState,
      Partial<InvocationState>,
      string
    >(InvocationState);
    graphCompiler.compileGraph<InvocationState>({
      plan,
      registry: f.registry,
      run: f.run,
      execution,
      runtime: {
        executor: new DefaultNodeExecutor(f.registry, f.bindings, f.codec, f.nodeRuns),
        services: { bindings: f.bindings, codec: f.codec },
        childGraphRuns: f.nodeRuns,
      },
      target: {
        addNode: (id, execute, options) => {
          builder.addNode(id, execute, options);
        },
        addBoundaryNode: (id, execute) => {
          builder.addNode(id, execute);
        },
        addEdge: (source, target) => {
          builder.addEdge(source, target);
        },
        addConditionalEdges: (id, route, paths) => {
          builder.addConditionalEdges(id, route, paths);
        },
      },
    });
    return builder.compile();
  }
  async function parentExecution(key: string): Promise<GraphExecutionIdentity> {
    const occurrence = await f.nodeRuns.getOrCreateOccurrence({
      workflowRunId: f.run.id,
      nodeId: `owner-${key}`,
      scopeKey: 'root',
    });
    const parent = await f.nodeRuns.createRunning({
      workflowRunId: f.run.id,
      nodeId: occurrence.nodeId,
      occurrenceId: occurrence.id,
    });
    await f.nodeRuns.updateInputs(parent.id, {});
    const scopeKey = deriveChildScope('root', {
      kind: 'subworkflow_call',
      ownerOccurrenceId: occurrence.id,
      ownerNodeRunId: parent.id,
      slot: 'graph',
      callKey: key,
    });
    const child = await f.nodeRuns.getOrCreateChildExecutionRunning({
      workflowRunId: f.run.id,
      parentNodeRunId: parent.id,
      parentNodeId: parent.nodeId,
      scopeKey,
      kind: 'fixture_graph',
      invocationKey: key,
      metadata: {},
    });
    return { scopeKey, childExecutionId: child.id };
  }
  const initial = (invocation: GraphExecutionIdentity): InvocationState => ({
    ...f.initial(),
    invocation,
  });
  // 父 NodeRun 已经创建且输入已审计；拦截下一步，不创建 SubWorkflow 自己的 child。
  const stopBeforeChild = () => f.nodeRuns.getOrCreateChildExecutionRunning.mockRejectedValue(stop);
  const parents = () => f.nodeRuns.getRecords().filter((row) => row.nodeId === f.parent.id);
  return { ...f, resolve, compile, parentExecution, initial, stopBeforeChild, parents };
}

describe('SubWorkflow 当前 Graph Execution Context 身份', () => {
  it('fixed root 仍创建 root occurrence，父 NodeRun 没有 childExecutionId', async () => {
    const f = fixture();
    f.stopBeforeChild();
    const graph = f.compile({ identity: { scopeKey: 'root' } });
    await expect(graph.invoke(f.initial({ scopeKey: 'unused' }))).rejects.toBe(stop);
    expect(f.parents()).toMatchObject([{ scopeKey: 'root', attempt: 1 }]);
    expect(f.parents()[0]).not.toHaveProperty('childExecutionId');
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.nodeRuns.getItemRecords()).toEqual([]);
  });

  it('动态私有 invocation 通道在子图过滤前读取，父 NodeRun 属于真实当前 child', async () => {
    const f = fixture();
    const identity = await f.parentExecution('A');
    f.stopBeforeChild();
    const graph = f.compile();
    expect(f.resolve).not.toHaveBeenCalled();
    await expect(graph.invoke(f.initial(identity))).rejects.toBe(stop);
    expect(f.parents()).toMatchObject([{ ...identity, attempt: 1 }]);
    expect(f.nodeRuns.getOccurrence(f.parents()[0]!.occurrenceId)).toMatchObject({
      nodeId: 'sub',
      scopeKey: identity.scopeKey,
    });
    expect(f.nodeRuns.createRunning).toHaveBeenLastCalledWith({
      workflowRunId: f.run.id,
      nodeId: 'sub',
      occurrenceId: f.parents()[0]!.occurrenceId,
      childExecutionId: identity.childExecutionId,
    });
    // Runnable input adapter 仍向 LangGraph 显式登记原生子图。
    expect([...graph.getSubgraphs()].map(([name]) => name)).toEqual(['sub']);
    expect(f.nodeRuns.getItemRecords()).toHaveLength(1);
  });

  it('同一编译图中的 A / B child 与 root 同名节点不共用 occurrence 或 attempt', async () => {
    const f = fixture();
    const a = await f.parentExecution('A');
    const b = await f.parentExecution('B');
    f.stopBeforeChild();
    const graph = f.compile();
    const identities = [{ scopeKey: 'root' }, a, b];
    await Promise.all(
      identities.map((identity) => expect(graph.invoke(f.initial(identity))).rejects.toBe(stop)),
    );
    const parents = f.parents();
    expect(parents).toHaveLength(3);
    expect(new Set(parents.map((row) => row.occurrenceId)).size).toBe(3);
    for (const identity of identities) {
      const parent = parents.find((row) => row.scopeKey === identity.scopeKey)!;
      expect(parent).toMatchObject({ ...identity, attempt: 1 });
      expect(parent.childExecutionId).toBe(identity.childExecutionId);
    }
  });

  it('同一 occurrence 新 attempt 保留所属 child，后续 child 身份从新 Parent NodeRun 派生', async () => {
    const f = fixture();
    const identity = await f.parentExecution('A');
    f.stopBeforeChild();
    const graph = f.compile();
    await expect(graph.invoke(f.initial(identity))).rejects.toBe(stop);
    await expect(graph.invoke(f.initial(identity))).rejects.toBe(stop);
    const [first, second] = f.parents();
    expect(second).toMatchObject({
      ...identity,
      occurrenceId: first!.occurrenceId,
      attempt: 2,
    });
    expect(second!.id).not.toBe(first!.id);
    const calls = f.nodeRuns.getOrCreateChildExecutionRunning.mock.calls.slice(-2);
    for (const [index, parent] of [first!, second!].entries()) {
      expect(calls[index]![0]).toEqual({
        workflowRunId: f.run.id,
        parentNodeRunId: parent.id,
        parentNodeId: 'sub',
        scopeKey: deriveChildScope(identity.scopeKey, {
          kind: 'subworkflow_call',
          ownerOccurrenceId: parent.occurrenceId,
          ownerNodeRunId: parent.id,
          slot: 'graph',
          callKey: SUBWORKFLOW_INVOCATION_KEY,
        }),
        kind: 'subworkflow',
        invocationKey: SUBWORKFLOW_INVOCATION_KEY,
        metadata: {},
      });
    }
    expect(calls[0]![0].scopeKey).not.toBe(calls[1]![0].scopeKey);
    expect(f.nodeRuns.getItemRecords()).toHaveLength(1);
  });

  it('动态 context 解析失败直接传播，不静默回退 root 或创建父审计', async () => {
    const f = fixture();
    const cause = new Error('当前 execution identity 不可用');
    f.resolve.mockImplementation(() => {
      throw cause;
    });
    await expect(f.compile().invoke(f.initial({ scopeKey: 'root' }))).rejects.toBe(cause);
    expect(f.nodeRuns.getOrCreateOccurrence).not.toHaveBeenCalled();
    expect(f.parents()).toEqual([]);
  });
});

it('shared graph runtime 将同一个 childGraphRuns 传入 Iteration Body，不执行组合图', () => {
  const f = iterationRuntimeFixture(1);
  const plan = prepareGraphCompilation({
    definition: f.definition,
    definitionLocation: { workflowVersionId: f.run.workflowVersionId, path: [] },
    registry: f.registry,
    strategies: strategies(),
  });
  const compile = vi.spyOn(graphCompiler, 'compileGraph');
  const builder = new StateGraph<
    typeof WorkflowStateAnnotation.spec,
    WorkflowState,
    Partial<WorkflowState>,
    string
  >(WorkflowStateAnnotation);
  graphCompiler.compileGraph({
    plan,
    registry: f.registry,
    run: f.run,
    execution: { identity: { scopeKey: 'root' } },
    runtime: {
      executor: new DefaultNodeExecutor(f.registry, f.bindings, f.codec, f.nodeRuns),
      services: { bindings: f.bindings, codec: f.codec },
      iterationRuns: f.nodeRuns,
      childGraphRuns: f.nodeRuns,
    },
    target: {
      addNode: (id, execute, options) => {
        builder.addNode(id, execute, options);
      },
      addBoundaryNode: (id, execute) => {
        builder.addNode(id, execute);
      },
      addEdge: (source, target) => {
        builder.addEdge(source, target);
      },
      addConditionalEdges: (id, route, paths) => {
        builder.addConditionalEdges(id, route, paths);
      },
    },
  });
  const body = compile.mock.calls.find(([context]) => context.plan === plan.children[0]!.plan);
  expect(body?.[0].runtime.childGraphRuns).toBe(f.nodeRuns);
  expect(f.nodeRuns.getRecords()).toEqual([]);
  expect(f.nodeRuns.getItemRecords()).toEqual([]);
});

it('Publish / Compiler 仍拒绝 Iteration Body 内 SubWorkflow，不创建执行服务或审计', async () => {
  const f = iterationRuntimeFixture(1);
  f.registry.register(createSubworkflowNodeType());
  f.body.nodes = [
    {
      ...f.bodyNode('sub'),
      type: 'flow.subworkflow',
      inputs: {},
      config: {},
      composite: {
        kind: 'subworkflow',
        graph: { inputs: [], nodes: [], edges: [], outputs: [] },
      },
    },
  ];
  f.body.outputs = [];
  f.definition.nodes = [f.loop];
  f.definition.edges = [];
  f.definition.outputs = [];
  const issue = { code: 'ITERATION_BODY_CAPABILITY_UNSUPPORTED', nodeId: 'sub' };
  expect(() => validateWorkflowForPublish(f.definition, f.registry)).toThrow(
    expect.objectContaining(issue),
  );
  await expect(f.createCompiler().compile(f.definition, f.run)).rejects.toMatchObject(issue);
  expect(f.createExecutor).not.toHaveBeenCalled();
  expect(f.nodeRuns.getRecords()).toEqual([]);
  expect(f.nodeRuns.getItemRecords()).toEqual([]);
});
