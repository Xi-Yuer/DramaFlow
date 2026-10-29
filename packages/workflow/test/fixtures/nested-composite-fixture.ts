import {
  StringType,
  type GraphDefinitionPath,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@dramaflow/contracts';
import { MemorySaver, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph';
import { vi } from 'vitest';
import {
  ActionNodeCompilationStrategy,
  DefaultNodeExecutor,
  DefaultWorkflowOutputResolver,
  DefaultWorkflowRunner,
  WorkflowStateAnnotation,
  type IterationRunRepository,
  type WorkflowState,
} from '../../src/index.js';
import { analyzeGraphCompilation } from '../../src/compiler/graph/compilation-plan.js';
import {
  compileGraph,
  type GraphExecutionContext,
} from '../../src/compiler/graph/graph-compiler.js';
import { IfNodeCompilationStrategy } from '../../src/compiler/if/strategy.js';
import { HumanReviewNodeCompilationStrategy } from '../../src/compiler/human-review/strategy.js';
import { IterationNodeCompilationStrategy } from '../../src/compiler/iteration/strategy.js';
import { SubWorkflowNodeCompilationStrategy } from '../../src/compiler/subworkflow/strategy.js';
import { subworkflowRuntimeFixture } from './subworkflow-runtime-fixture.js';
import { workflowRunnerFixture } from './workflow-runner-fixture.js';

// 仅在 strategy 测试中装配合法内部调用；正式 Compiler / Publish 仍走原 gate。
export function nestedCompositeFixture(nested = true) {
  const f = subworkflowRuntimeFixture();
  const action = f.registry.getAction('test.format_text', 1);
  const execute = vi.fn(action.execute);
  f.registry.register({
    ...action,
    manifest: { ...action.manifest, type: 'test.failure' },
    execute,
  });
  f.child.nodes[0]!.type = 'test.failure';
  const array = { kind: 'array' as const, itemType: StringType };
  if (nested) {
    f.definition.inputs = [{ name: 'items', type: array, required: true }];
    f.definition.nodes = [
      {
        id: 'iterate',
        type: 'flow.iteration',
        typeVersion: 1,
        name: '逐项',
        config: {},
        inputs: { items: { type: 'workflow_input', key: 'items' } },
        ui: { position: { x: 0, y: 0 } },
        composite: {
          kind: 'iteration',
          itemType: StringType,
          invariantInputs: [],
          bodyInputMapping: [{ target: 'text', source: { type: 'current_item' } }],
          body: {
            inputs: [{ name: 'text', type: StringType, required: true }],
            nodes: [f.parent],
            edges: [],
            outputs: [
              { name: 'text', type: StringType, source: { nodeId: 'sub', outputKey: 'text' } },
            ],
          },
        },
      },
    ];
    f.definition.outputs = [
      { name: 'result', type: array, source: { nodeId: 'iterate', outputKey: 'text' } },
    ];
    f.run.inputs = { items: { storage: 'inline', type: array, value: ['A'] } };
  }
  const saver = new MemorySaver();
  function compile(
    definition: WorkflowDefinition = f.definition,
    run: WorkflowRun = f.run,
    options: {
      checkpointer?: BaseCheckpointSaver;
      execution?: GraphExecutionContext<WorkflowState>;
      path?: GraphDefinitionPath;
      runs?: IterationRunRepository;
    } = {},
  ) {
    const plan = analyzeGraphCompilation({
      definition,
      definitionLocation: {
        workflowVersionId: run.workflowVersionId,
        path: [...(options.path ?? [])],
      },
      registry: f.registry,
      strategies: {
        action: new ActionNodeCompilationStrategy(),
        if: new IfNodeCompilationStrategy(),
        review: new HumanReviewNodeCompilationStrategy(),
        iteration: new IterationNodeCompilationStrategy(),
        subworkflow: new SubWorkflowNodeCompilationStrategy(),
      },
    });
    const builder = new StateGraph<
      typeof WorkflowStateAnnotation.spec,
      WorkflowState,
      Partial<WorkflowState>,
      string
    >(WorkflowStateAnnotation);
    const runs = options.runs ?? f.nodeRuns;
    compileGraph({
      plan,
      registry: f.registry,
      run,
      execution: options.execution ?? { identity: { scopeKey: 'root' } },
      runtime: {
        executor: new DefaultNodeExecutor(f.registry, f.bindings, f.codec, runs),
        services: { bindings: f.bindings, codec: f.codec },
        iterationRuns: runs,
        childGraphRuns: runs,
      },
      target: {
        addNode: (id, node, options) => {
          builder.addNode(id, node, options);
        },
        addBoundaryNode: (id, node) => {
          builder.addNode(id, node);
        },
        addEdge: (source, target) => {
          builder.addEdge(source, target);
        },
        addConditionalEdges: (id, route, paths) => {
          builder.addConditionalEdges(id, route, paths);
        },
      },
    });
    return builder
      .compile({ checkpointer: options.checkpointer ?? saver })
      .withConfig({ recursionLimit: plan.budget.recursionLimit });
  }
  async function runWithRunner() {
    const harness = workflowRunnerFixture();
    Object.assign(harness.version, {
      id: f.run.workflowVersionId,
      workflowId: f.run.workflowId,
      projectId: f.run.projectId,
      definition: f.definition,
    });
    const runner = new DefaultWorkflowRunner(
      { getVersion: harness.getVersion },
      harness.runs,
      {
        compile: async (definition, run) =>
          nested ? compile(definition, run) : f.createCompiler(saver).compile(definition, run),
      },
      new DefaultWorkflowOutputResolver(),
    );
    const run = await harness.runs.create({
      workflowId: f.run.workflowId,
      workflowVersionId: f.run.workflowVersionId,
      projectId: f.run.projectId,
      invocationKey: f.run.invocationKey,
      inputs: f.run.inputs,
    });
    return { run, runner, runs: harness.runs };
  }
  return { ...f, execute, compile, saver, runWithRunner };
}
