import type { ChildGraphRunRepository } from '../../runtime/execution/child-execution-repository.js';
import type { RuntimeValue, WorkflowRun } from '@dramaflow/contracts';
import type { RunnableInterface } from '@langchain/core/runnables';
import {
  START,
  END,
  type AddNodeOptions,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import type { GraphExecutionIdentity } from '../../runtime/execution/execution-scope.js';
import type { NodeRegistry } from '../../node/registry/registry.js';
import type { NodeExecutor } from '../../runtime/node/node-executor.js';
import type { HumanReviewNodeRunRepository } from '../../runtime/execution/node-run-repository.js';
import type { WorkflowState, WorkflowStateUpdate } from '../../runtime/state/state.js';
import { DefaultWorkflowOutputResolver } from '../../runtime/state/workflow-output-resolver.js';
import type { IterationRunRepository } from '../iteration/execution-repository.js';
import type { LangGraphNode, WorkflowValueServices } from '../strategy.js';
import { collectNodeDependencies, DependencyCompiler } from '../dependency/dependency.compiler.js';
import { readIfRoute } from '../if/strategy.js';
import type { GraphCompilationPlan } from './compilation-plan.js';

export type { GraphExecutionIdentity } from '../../runtime/execution/execution-scope.js';
export type GraphExecutionContext<State extends WorkflowState> =
  | { identity: GraphExecutionIdentity }
  | { resolve(state: State, config: LangGraphRunnableConfig): GraphExecutionIdentity };
export type CompiledGraphNode<State extends WorkflowState> =
  LangGraphNode<State> | RunnableInterface<State, WorkflowStateUpdate, LangGraphRunnableConfig>;
export type GraphNodeRegistrationOptions = Pick<AddNodeOptions, 'subgraphs'>;
export interface GraphCompilationTarget<State extends WorkflowState> {
  addNode(id: string, node: CompiledGraphNode<State>, options?: GraphNodeRegistrationOptions): void;
  addBoundaryNode(
    id: string,
    node: (state: State, config: LangGraphRunnableConfig) => Promise<Partial<State>>,
  ): void;
  addEdge(source: string | string[], target: string): void;
  addConditionalEdges(
    id: string,
    route: (state: State) => 'true' | 'false',
    paths: { true: string; false: string },
  ): void;
}
export interface GraphCompilationContext<State extends WorkflowState> {
  plan: GraphCompilationPlan;
  registry: NodeRegistry;
  run: WorkflowRun;
  execution: GraphExecutionContext<State>;
  runtime: {
    executor?: NodeExecutor;
    services?: WorkflowValueServices;
    reviewRuns?: HumanReviewNodeRunRepository;
    iterationRuns?: IterationRunRepository;
    childGraphRuns?: ChildGraphRunRepository;
  };
  target: GraphCompilationTarget<State>;
  entry?: {
    name: string;
    execute(state: State, config: LangGraphRunnableConfig): Promise<Partial<State>>;
  };
  completion?: {
    name: string;
    execute(state: State, outputs: Record<string, RuntimeValue>): Promise<Partial<State>>;
    onOutputError(state: State, error: unknown): Promise<never>;
  };
  wrapNode?(node: LangGraphNode<State>): LangGraphNode<State>;
}
export function readGraphExecutionIdentity<State extends WorkflowState>(
  execution: GraphExecutionContext<State>,
  state: State,
  config: LangGraphRunnableConfig,
): GraphExecutionIdentity {
  return 'identity' in execution ? execution.identity : execution.resolve(state, config);
}
function fixedIdentity<State extends WorkflowState>(
  execution: GraphExecutionContext<State>,
): GraphExecutionIdentity {
  if (!('identity' in execution))
    throw new Error('当前控制策略需要固定父作用域；动态嵌套调用尚未开放');
  return execution.identity;
}
function internalNodeId(
  definition: GraphCompilationPlan['definition'],
  name: string,
  used: Set<string>,
): string {
  let id = name;
  while (definition.nodes.some((node) => node.id === id) || used.has(id)) id += '_';
  used.add(id);
  return id;
}

// 修改调用方提供的原生图 builder，不 invoke、不做输入映射、不创建执行记录或 Saver。
// State schema / reducers 与原生 compile(checkpointer) 仍由 root 或 Composite 拥有。
export function compileGraph<State extends WorkflowState>(
  context: GraphCompilationContext<State>,
): void {
  const { plan, registry, run, runtime, target, execution } = context;
  const { definition, strategies } = plan;
  if (plan.definitionLocation.workflowVersionId !== run.workflowVersionId)
    throw new Error('Graph 定义位置与固定运行版本不匹配');
  if (
    !!context.entry !== !!plan.boundary.entry ||
    !!context.completion !== !!plan.boundary.completion
  )
    throw new Error('Graph 编译边界与已证明预算不一致');
  const addNode = (id: string, node: LangGraphNode<State>) =>
    target.addNode(id, context.wrapNode ? context.wrapNode(node) : node);
  for (const { node, declaration, strategy } of plan.entries) {
    switch (strategy) {
      case 'action':
        if (!runtime.executor) throw new Error('Action 执行服务未配置');
        strategies.action.compile({
          node,
          manifest: declaration.manifest,
          executor: runtime.executor,
          executionContext: (config, state) => ({
            workflow: definition,
            runnableConfig: config,
            ...readGraphExecutionIdentity(execution, state, config),
          }),
          addNode,
        });
        break;
      case 'if':
        if (!runtime.services) throw new Error('If 执行服务未配置');
        strategies.if.compile({
          node,
          declaration,
          workflow: definition,
          services: runtime.services,
          addNode,
        });
        break;
      case 'review':
        if (!runtime.services || !runtime.reviewRuns)
          throw new Error('Human Review 执行服务未配置');
        strategies.review.compile({
          node,
          declaration,
          workflow: definition,
          services: runtime.services,
          nodeRuns: runtime.reviewRuns,
          scopeKey: fixedIdentity(execution).scopeKey,
          addNode,
        });
        break;
      case 'subworkflow': {
        if (!strategies.subworkflow || !runtime.services || !runtime.childGraphRuns)
          throw new Error('SubWorkflow 执行服务未配置');
        const child = plan.children.find(
          (child) => child.ownerNodeId === node.id && child.graphKey === 'graph',
        );
        if (!child) throw new Error('SubWorkflow child 编译计划缺失');
        strategies.subworkflow.compile({
          node,
          declaration,
          workflow: definition,
          run,
          execution,
          registry,
          executor: runtime.executor,
          services: runtime.services,
          runs: runtime.childGraphRuns,
          childCompilation: child.plan,
          addNode: (id, graph, options) => target.addNode(id, graph, options),
        });
        break;
      }
      case 'iteration': {
        if (!runtime.executor || !runtime.services || !runtime.iterationRuns)
          throw new Error('Iteration 执行服务未配置');
        const body = plan.children.find(
          (child) => child.ownerNodeId === node.id && child.graphKey === 'body',
        );
        if (!body) throw new Error('Iteration body 编译计划缺失');
        strategies.iteration.compile({
          node,
          declaration,
          workflow: definition,
          run,
          scopeKey: fixedIdentity(execution).scopeKey,
          registry,
          executor: runtime.executor,
          services: runtime.services,
          runs: runtime.iterationRuns,
          childGraphRuns: runtime.childGraphRuns,
          bodyCompilation: body.plan,
          addNode: (id, child) => target.addNode(id, child),
        });
        break;
      }
    }
  }
  const used = new Set<string>();
  const entry = context.entry ? internalNodeId(definition, context.entry.name, used) : START;
  const completion = context.completion
    ? internalNodeId(definition, context.completion.name, used)
    : END;
  if (context.entry) {
    target.addBoundaryNode(entry, context.entry.execute);
    target.addEdge(START, entry);
  }
  if (context.completion) {
    const handler = context.completion;
    const resolver = new DefaultWorkflowOutputResolver();
    target.addBoundaryNode(completion, async (state) => {
      let outputs: Record<string, RuntimeValue>;
      try {
        outputs = resolver.resolve(definition, state);
      } catch (error) {
        return handler.onOutputError(state, error);
      }
      return handler.execute(state, outputs);
    });
    target.addEdge(completion, END);
  }
  const dependencies = collectNodeDependencies(definition.edges, definition.nodes);
  new DependencyCompiler().compile({
    nodes: definition.nodes,
    edges: definition.edges,
    ...(plan.ifAnalysis ? { dependencies: plan.ifAnalysis.staticDependencies } : {}),
    addEdge: (source, targetId) => target.addEdge(source, targetId),
  });
  const targets = new Set(dependencies.map((dependency) => dependency.targetNodeId));
  const sources = new Set(dependencies.flatMap((dependency) => dependency.sourceNodeIds));
  const roots =
    plan.ifAnalysis?.roots ??
    definition.nodes.filter((node) => !targets.has(node.id)).map((node) => node.id);
  const leaves =
    plan.ifAnalysis?.leaves ??
    definition.nodes.filter((node) => !sources.has(node.id)).map((node) => node.id);
  if (plan.ifAnalysis)
    for (const route of plan.ifAnalysis.routes)
      target.addConditionalEdges(route.nodeId, (state) => readIfRoute(state, route.nodeId), {
        true: route.true,
        false: route.false,
      });
  for (const root of roots) target.addEdge(entry, root);
  if (!definition.nodes.length) {
    target.addEdge(entry, completion);
    return;
  }
  if (context.completion) {
    // 现有局部图为 Action DAG；条件图若有多个互斥出口，不能错误添加 ALL barrier。
    if (plan.ifAnalysis && leaves.length !== 1)
      throw new Error('条件局部图输出收口需要已证明的唯一终点');
    target.addEdge(leaves, completion);
  } else for (const leaf of leaves) target.addEdge(leaf, END);
}
