import {
  NumberType,
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
import { END, START, Send, StateGraph, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { NodeRegistry } from '../../node/registry.js';
import type { NodeOccurrenceRepository } from '../../run/node-run-repository.js';
import { DefaultWorkflowOutputResolver } from '../../run/workflow-output-resolver.js';
import { deriveChildScope } from '../../runtime/execution-scope.js';
import {
  createLocalGraphInvocation,
  type GraphInputMapping,
} from '../../runtime/graph-invocation.js';
import { assertIterationCompatibility } from '../../runtime/iteration-compatibility.js';
import type { NodeExecutor } from '../../runtime/node-executor.js';
import type { WorkflowState, WorkflowStateUpdate } from '../../runtime/state.js';
import {
  OrderedRuntimeCollectionBuilder,
  RuntimeCollectionSnapshot,
} from '../../runtime/values/runtime-collection.js';
import { analyzeStaticDagExecution } from '../action-dag-execution-analysis.js';
import { collectNodeDependencies, DependencyCompiler } from '../dependency.compiler.js';
import {
  ActionNodeCompilationStrategy,
  type NodeCompilationStrategy,
  type WorkflowValueServices,
} from '../strategy.js';
import type { NodeDeclaration } from '../../node/type.js';
import {
  AggregateOutput,
  FRAME,
  INVOCATION,
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
  occurrences: NodeOccurrenceRepository;
  addNode(
    id: string,
    node: RunnableInterface<WorkflowState, WorkflowStateUpdate, LangGraphRunnableConfig>,
  ): void;
}
export function iterationRecursionLimit(node: NodeDefinition): number {
  if (!node.composite) throw new Error('Iteration composite 定义缺失');
  // 父图、Iteration 图和 body 图各自计数。Send 的 item 数不是 superstep。
  // body 预算是静态深度加 declared-output；prepare / fan-out / collect 由下限覆盖。
  // 编译器再取它和父图静态预算的较大值，避免把动态 item 数加进递归上限。
  return Math.max(4, analyzeStaticDagExecution(node.composite.body).maxDepth + 2);
}

export class IterationNodeCompilationStrategy implements NodeCompilationStrategy<IterationCompilationContext> {
  supports(manifest: NodeTypeManifest): boolean {
    return isIterationNodeManifest(manifest);
  }

  compile(context: IterationCompilationContext): void {
    const { node, workflow, registry, executor, services, run, scopeKey, occurrences } = context;
    if (!this.supports(context.declaration.manifest) || !node.composite)
      throw new Error('Iteration strategy 仅支持 flow.iteration@1');
    const composite = node.composite;
    const body = composite.body;
    const ports = registry.resolveNodePorts(node);
    const outputResolver = new DefaultWorkflowOutputResolver();
    const childScope = (ownerOccurrenceId: string, index: number) =>
      deriveChildScope(scopeKey, {
        kind: 'iteration_item',
        ownerOccurrenceId,
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
    const action = new ActionNodeCompilationStrategy();
    for (const bodyNode of body.nodes) {
      const declaration = registry.get(bodyNode.type, bodyNode.typeVersion);
      if (!action.supports(declaration.manifest))
        throw new Error('Iteration body 仅支持已通过 Publish 的 Action');
      action.compile<typeof ItemState.State>({
        node: bodyNode,
        manifest: declaration.manifest,
        executor,
        executionContext: (config, state) => ({
          workflow: body,
          scopeKey: itemInvocationSchema.parse(state[INVOCATION]).scopeKey,
          runnableConfig: config,
        }),
        addNode: (id, execute) => {
          itemGraph.addNode(id, execute);
        },
      });
    }
    let declaredOutputNode = '__dramaflow_body_outputs';
    while (body.nodes.some((candidate) => candidate.id === declaredOutputNode))
      declaredOutputNode += '_';
    itemGraph.addNode(declaredOutputNode, (state) => {
      const invocation = itemInvocationSchema.parse(state[INVOCATION]);
      return {
        [RESULTS]: [
          {
            index: invocation.index,
            ownerOccurrenceId: invocation.ownerOccurrenceId,
            scopeKey: invocation.scopeKey,
            outputs: outputResolver.resolve(body, state),
          },
        ],
      };
    });
    const dependencies = collectNodeDependencies(body.edges, body.nodes);
    new DependencyCompiler().compile({
      nodes: body.nodes,
      edges: body.edges,
      addEdge: (sources, target) => {
        itemGraph.addEdge(sources, target);
      },
    });
    const targets = new Set(dependencies.map((dependency) => dependency.targetNodeId));
    const sources = new Set(dependencies.flatMap((dependency) => dependency.sourceNodeIds));
    for (const bodyNode of body.nodes) {
      if (!targets.has(bodyNode.id)) itemGraph.addEdge(START, bodyNode.id);
    }
    // 一个 barrier 汇聚所有叶节点，完成后才解析 body declared outputs。
    itemGraph.addEdge(
      body.nodes.filter((bodyNode) => !sources.has(bodyNode.id)).map((bodyNode) => bodyNode.id),
      declaredOutputNode,
    );
    itemGraph.addEdge(declaredOutputNode, END);
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
      const inputs = await services.bindings.resolveInputs({
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
      const items = inputs.items;
      if (!items) throw new Error('Iteration items 缺失');
      const occurrence = await occurrences.getOrCreateOccurrence({
        workflowRunId: run.id,
        nodeId: node.id,
        scopeKey,
      });
      const snapshot = await RuntimeCollectionSnapshot.create(items, services.codec, {
        projectId: run.projectId,
        workflowRunId: run.id,
      });
      const { items: _items, ...invariantInputs } = inputs;
      return {
        [FRAME]: {
          snapshot: collectionRuntimeValueSchema.parse(snapshot.toRuntimeValue()),
          invariantInputs,
          ownerOccurrenceId: occurrence.id,
        },
      };
    });
    iterationGraph.addNode('body', compiledBody, { input: ItemInput });
    iterationGraph.addNode('collect', (state) => {
      const frame = frameSchema.parse(state[FRAME]);
      const builders = new Map(
        body.outputs.map((output) => [
          output.name,
          new OrderedRuntimeCollectionBuilder(output.type, frame.snapshot.elements.length),
        ]),
      );
      for (const result of state[RESULTS]) {
        if (
          result.ownerOccurrenceId !== frame.ownerOccurrenceId ||
          result.scopeKey !== childScope(frame.ownerOccurrenceId, result.index)
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
      return {
        outputs: {
          [node.id]: Object.fromEntries(
            [...builders].map(([name, builder]) => [name, builder.build()]),
          ),
        },
      };
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
            definitionLocation: {
              workflowVersionId: run.workflowVersionId,
              path: [{ nodeId: node.id, graphKey: 'body' }],
            },
            scopeKey: childScope(frame.ownerOccurrenceId, index),
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
    context.addNode(node.id, iterationGraph.compile());
  }
}
