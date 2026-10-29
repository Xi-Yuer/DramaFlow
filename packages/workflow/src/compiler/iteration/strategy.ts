import {
  NumberType,
  workflowIdentifierSchema,
  collectionRuntimeValueSchema,
  isTypeAssignable,
  isIterationNodeManifest,
  type NodeDefinition,
  type NodeTypeManifest,
  type RuntimeValue,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@dramaflow/contracts';
import type { RunnableInterface } from '@langchain/core/runnables';
import {
  END,
  START,
  Send,
  StateGraph,
  isGraphBubbleUp,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import { NodeRegistry } from '../../node/registry/registry.js';
import type { IterationRunRepository } from './execution-repository.js';
import type { ChildGraphRunRepository } from '../../runtime/execution/child-execution-repository.js';
import { failNodeRun, NodeExecutionError } from '../../runtime/node/node-execution-error.js';
import { failCompositeExecution } from '../../runtime/execution/composite-failure-boundary.js';
import { deriveChildScope } from '../../runtime/execution/execution-scope.js';
import {
  createLocalGraphInvocation,
  type GraphInputMapping,
} from '../../runtime/execution/graph-invocation.js';
import { assertIterationCompatibility } from './compatibility.js';
import type { NodeExecutor } from '../../runtime/node/node-executor.js';
import type { WorkflowState, WorkflowStateUpdate } from '../../runtime/state/state.js';
import {
  OrderedRuntimeCollectionBuilder,
  RuntimeCollectionSnapshot,
} from '../../runtime/values/runtime-collection.js';
import { compileGraph } from '../graph/graph-compiler.js';
import type { GraphNodeRegistrationOptions } from '../graph/graph-compiler.js';
import {
  type GraphCompilationPlan,
  type GraphStrategyStructure,
} from '../graph/compilation-plan.js';
import { type NodeCompilationStrategy, type WorkflowValueServices } from '../strategy.js';
import type { NodeDeclaration } from '../../node/registry/type.js';
import {
  AggregateOutput,
  FRAME,
  INVOCATION,
  CHILD_EXECUTION,
  ItemInput,
  ItemOutput,
  ItemState,
  IterationState,
  ParentInput,
  RESULTS,
  frameSchema,
  itemInvocationSchema,
} from './state.js';

export interface IterationCompilationContext {
  node: NodeDefinition;
  declaration: NodeDeclaration;
  workflow: WorkflowDefinition;
  run: WorkflowRun;
  scopeKey: string;
  registry: NodeRegistry;
  executor: NodeExecutor;
  services: WorkflowValueServices;
  runs: IterationRunRepository;
  childGraphRuns?: ChildGraphRunRepository;
  bodyCompilation: GraphCompilationPlan;
  addNode(
    id: string,
    node: RunnableInterface<WorkflowState, WorkflowStateUpdate, LangGraphRunnableConfig>,
    options?: GraphNodeRegistrationOptions,
  ): void;
}
export class IterationNodeCompilationStrategy implements NodeCompilationStrategy<IterationCompilationContext> {
  supports(manifest: NodeTypeManifest): boolean {
    return isIterationNodeManifest(manifest);
  }

  graphStructure(): GraphStrategyStructure {
    return { wrapperNodes: 3, childBoundaries: { body: { entry: true, completion: true } } };
  }

  compile(context: IterationCompilationContext): void {
    const { node, workflow, registry, executor, services, run, scopeKey, runs } = context;
    if (!this.supports(context.declaration.manifest) || node.composite?.kind !== 'iteration')
      throw new Error('Iteration strategy 仅支持 flow.iteration@1');
    const composite = node.composite;
    const body = composite.body;
    const ports = registry.resolveNodePorts(node);
    const childScope = (ownerOccurrenceId: string, ownerNodeRunId: string, index: number) =>
      deriveChildScope(scopeKey, {
        kind: 'iteration_item',
        ownerOccurrenceId,
        ownerNodeRunId,
        slot: 'body',
        index,
      });
    const itemGraph = new StateGraph<
      typeof ItemState.spec,
      typeof ItemState.State,
      Partial<typeof ItemState.State>,
      string,
      typeof ItemInput.spec,
      typeof ItemOutput.spec
    >({ stateSchema: ItemState, input: ItemInput, output: ItemOutput });
    const itemId = (state: typeof ItemState.State) =>
      workflowIdentifierSchema.parse(state[CHILD_EXECUTION]);
    // 原生控制流与仓储故障交回 LangGraph；不把未完成 / 受理不明记成业务失败。
    const failItem = (state: typeof ItemState.State, cause: unknown): Promise<never> =>
      failCompositeExecution(itemId(state), cause, (error) =>
        runs.markIterationItemFailed(itemId(state), error),
      );
    compileGraph<typeof ItemState.State>({
      plan: context.bodyCompilation,
      registry,
      run,
      execution: {
        resolve: (state) => ({
          scopeKey: itemInvocationSchema.parse(state[INVOCATION]).scopeKey,
          childExecutionId: itemId(state),
        }),
      },
      runtime: { executor, services, iterationRuns: runs, childGraphRuns: context.childGraphRuns },
      target: {
        addNode: (id, execute, options) => {
          itemGraph.addNode(id, execute, options);
        },
        addBoundaryNode: (id, execute) => {
          itemGraph.addNode(id, execute);
        },
        addEdge: (sources, target) => {
          itemGraph.addEdge(sources, target);
        },
        addConditionalEdges: (id, route, paths) => {
          itemGraph.addConditionalEdges(id, route, paths);
        },
      },
      failureBoundary: failItem,
      entry: {
        name: '__dramaflow_item_start',
        execute: async (state) => {
          const invocation = itemInvocationSchema.parse(state[INVOCATION]);
          const item = await runs.getOrCreateIterationItemRunning({
            workflowRunId: run.id,
            parentNodeRunId: invocation.iterationNodeRunId,
            parentNodeId: node.id,
            scopeKey: invocation.scopeKey,
            index: invocation.index,
          });
          return { [CHILD_EXECUTION]: item.id };
        },
      },
      completion: {
        name: '__dramaflow_body_outputs',
        onOutputError: async (state, cause) => {
          if (cause !== null && isGraphBubbleUp(cause)) throw cause;
          return failItem(
            state,
            new NodeExecutionError(node.id, node.type, 'validate_output', cause),
          );
        },
        execute: async (state, outputs) => {
          const invocation = itemInvocationSchema.parse(state[INVOCATION]);
          await runs.markIterationItemCompleted(itemId(state));
          return {
            [RESULTS]: [
              {
                index: invocation.index,
                ownerOccurrenceId: invocation.ownerOccurrenceId,
                iterationNodeRunId: invocation.iterationNodeRunId,
                childExecutionId: itemId(state),
                scopeKey: invocation.scopeKey,
                outputs,
              },
            ],
          };
        },
      },
    });
    const compiledBody = itemGraph.compile();
    const iterationGraph = new StateGraph<
      typeof IterationState.spec,
      typeof IterationState.State,
      Partial<typeof IterationState.State>,
      string,
      typeof ParentInput.spec,
      typeof AggregateOutput.spec
    >({ stateSchema: IterationState, input: ParentInput, output: AggregateOutput });
    iterationGraph.addNode('prepare', async (state, config) => {
      assertIterationCompatibility(config);
      if (
        state.run.workflowRunId !== run.id ||
        state.run.workflowVersionId !== run.workflowVersionId ||
        state.run.projectId !== run.projectId
      )
        throw new Error('Iteration 与已授权 Run 不匹配');
      const occurrence = await runs.getOrCreateOccurrence({
        workflowRunId: run.id,
        nodeId: node.id,
        scopeKey,
      });
      const parent = await runs.createRunning({
        workflowRunId: run.id,
        nodeId: node.id,
        occurrenceId: occurrence.id,
      });
      let inputs: Record<string, RuntimeValue>;
      let snapshot: RuntimeCollectionSnapshot;
      try {
        inputs = await services.bindings.resolveInputs({
          node,
          nodeType: context.declaration.manifest,
          ports,
          edges: workflow.edges,
          workflowInputs: workflow.inputs,
          state,
        });
        for (const port of ports.inputs) {
          const input = Object.hasOwn(inputs, port.key) ? inputs[port.key] : undefined;
          if (!input && port.required) throw new Error('Iteration 缺少必填输入');
          if (input && !isTypeAssignable(input.type, port.dataType))
            throw new Error('Iteration 输入类型不兼容');
        }
        if (!inputs.items) throw new Error('Iteration items 缺失');
        snapshot = await RuntimeCollectionSnapshot.create(inputs.items, services.codec, {
          projectId: run.projectId,
          workflowRunId: run.id,
        });
      } catch (cause) {
        return failNodeRun(runs, node, parent.id, 'resolve_input', cause);
      }
      await runs.updateInputs(parent.id, inputs);
      const { items: _items, ...invariantInputs } = inputs;
      return {
        [FRAME]: {
          snapshot: collectionRuntimeValueSchema.parse(snapshot.toRuntimeValue()),
          invariantInputs,
          ownerOccurrenceId: occurrence.id,
          iterationNodeRunId: parent.id,
        },
      };
    });
    iterationGraph.addNode('body', compiledBody, { input: ItemInput });
    iterationGraph.addNode('collect', async (state) => {
      const frame = frameSchema.parse(state[FRAME]);
      let output: Record<string, RuntimeValue>;
      try {
        const builders = new Map(
          body.outputs.map((output) => [
            output.name,
            new OrderedRuntimeCollectionBuilder(output.type, frame.snapshot.elements.length),
          ]),
        );
        for (const result of state[RESULTS]) {
          if (
            result.ownerOccurrenceId !== frame.ownerOccurrenceId ||
            result.iterationNodeRunId !== frame.iterationNodeRunId ||
            result.scopeKey !==
              childScope(frame.ownerOccurrenceId, frame.iterationNodeRunId, result.index)
          )
            throw new Error('Iteration result 身份不匹配');
          for (const output of body.outputs) {
            const value = Object.hasOwn(result.outputs, output.name)
              ? result.outputs[output.name]
              : undefined;
            if (!value) throw new Error('Iteration body declared output 缺失');
            builders.get(output.name)!.add(result.index, value);
          }
        }
        if (state[RESULTS].length !== frame.snapshot.elements.length)
          throw new Error('Iteration 结果数量不完整');
        output = Object.fromEntries(
          [...builders].map(([name, builder]) => [name, builder.build()]),
        );
      } catch (cause) {
        return failNodeRun(runs, node, frame.iterationNodeRunId, 'validate_output', cause);
      }
      await runs.markCompleted(frame.iterationNodeRunId, output);
      return { outputs: { [node.id]: output } };
    });
    iterationGraph.addEdge(START, 'prepare');
    iterationGraph.addConditionalEdges(
      'prepare',
      (state) => {
        const frame = frameSchema.parse(state[FRAME]);
        if (!frame.snapshot.elements.length) return 'collect';
        return frame.snapshot.elements.map((item, index) => {
          const sources: Record<string, RuntimeValue> = {};
          const mappings: GraphInputMapping[] = [];
          for (const mapping of composite.bodyInputMapping) {
            const source = mapping.source;
            const value =
              source.type === 'current_item'
                ? item
                : source.type === 'current_index'
                  ? { storage: 'inline' as const, type: NumberType, value: index }
                  : source.key === 'items'
                    ? frame.snapshot
                    : Object.hasOwn(frame.invariantInputs, source.key)
                      ? frame.invariantInputs[source.key]
                      : undefined;
            // Publish 已证明 optional→optional；缺失来源不制造 null 或占位值。
            if (value === undefined) continue;
            sources[mapping.target] = value;
            mappings.push({ source: mapping.target, target: mapping.target });
          }
          const local = createLocalGraphInvocation({
            definition: body,
            definitionLocation: context.bodyCompilation.definitionLocation,
            scopeKey: childScope(frame.ownerOccurrenceId, frame.iterationNodeRunId, index),
            run: state.run,
            sources,
            mappings,
          });
          return new Send('body', {
            ...local.state,
            [INVOCATION]: {
              scopeKey: local.scopeKey,
              definitionLocation: local.definitionLocation,
              ownerOccurrenceId: frame.ownerOccurrenceId,
              iterationNodeRunId: frame.iterationNodeRunId,
              index,
            },
          });
        });
      },
      ['body', 'collect'],
    );
    iterationGraph.addEdge('body', 'collect');
    iterationGraph.addEdge('collect', END);
    // 直接嵌套 compiled graph，由 LangGraph 传播 checkpoint / pause / resume；无手写 invoke wrapper。
    const compiled = iterationGraph.compile();
    context.addNode(node.id, compiled, { subgraphs: [compiled] });
  }
}
