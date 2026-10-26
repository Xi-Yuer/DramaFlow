import {
  ROOT_EXECUTION_SCOPE_KEY,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@dramaflow/contracts';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  END,
  type Command,
  START,
  StateGraph,
  type BaseCheckpointSaver,
  type StateSnapshot,
} from '@langchain/langgraph';
import { WorkflowPublishValidationError } from '../definition/publish/validate-publish.js';
import { createWorkflowDefinitionSnapshot } from '../definition/contract/version.js';
import { NodeRegistry } from '../node/registry/registry.js';
import type { HumanReviewNodeRunRepository } from '../runtime/execution/node-run-repository.js';
import { validateWorkflowDefinitionSemantics } from './execution-capabilities.js';
import type { IterationRunRepository } from './iteration/execution-repository.js';
import type { NodeExecutor } from '../runtime/node/node-executor.js';
import { WorkflowStateAnnotation, type WorkflowState } from '../runtime/state/state.js';
import { collectNodeDependencies, DependencyCompiler } from './dependency/dependency.compiler.js';
import { ActionNodeCompilationStrategy, type WorkflowValueServices } from './strategy.js';
import { IfNodeCompilationStrategy, readIfRoute } from './if/strategy.js';
import { analyzeSimpleIfExecution } from './if/analysis.js';
import { HumanReviewNodeCompilationStrategy } from './human-review/strategy.js';
import { findUnsupportedHumanReviewTopology } from './human-review/analysis.js';
import { IterationNodeCompilationStrategy, iterationRecursionLimit } from './iteration/strategy.js';
import { assertIterationCompatibility } from './iteration/compatibility.js';
import { analyzeStaticDagExecution } from './dependency/action-dag-execution-analysis.js';

// Runner 仅发送 resume，不开放 Command.update / goto 的状态写入或路由能力。
export type WorkflowResumeCommand = Command<unknown, never, never>;
export interface CompiledWorkflow {
  invoke(
    input: WorkflowState | WorkflowResumeCommand | null,
    config: RunnableConfig,
  ): Promise<unknown>;
  getState(config: RunnableConfig, options?: { subgraphs?: boolean }): Promise<StateSnapshot>;
}

export interface WorkflowCompiler {
  compile(definition: WorkflowDefinition, run: WorkflowRun): Promise<CompiledWorkflow>;
}

// 显式创建限定本次运行权限的 Executor，不在 Compiler 中读写运行状态或选择 thread。
export type NodeExecutorFactory = (
  run: WorkflowRun,
  valueServices?: WorkflowValueServices,
) => Promise<NodeExecutor>;
export type WorkflowValueServicesFactory = (run: WorkflowRun) => Promise<WorkflowValueServices>;
export type IfExecutionServicesFactory = WorkflowValueServicesFactory;

export class DefaultWorkflowCompiler implements WorkflowCompiler {
  constructor(
    private readonly registry: NodeRegistry,
    private readonly createExecutor: NodeExecutorFactory,
    private readonly checkpointer: BaseCheckpointSaver,
    private readonly createValueServices?: WorkflowValueServicesFactory,
    private readonly createHumanReviewRuns?: (
      run: WorkflowRun,
    ) => Promise<HumanReviewNodeRunRepository>,
    private readonly createIterationRuns?: (run: WorkflowRun) => Promise<IterationRunRepository>,
  ) {}

  async compile(input: WorkflowDefinition, run: WorkflowRun): Promise<CompiledWorkflow> {
    const definition = createWorkflowDefinitionSnapshot(input);
    if (!this.checkpointer) throw new Error('WorkflowCompiler 必须显式注入 Checkpointer');
    const iterationStrategy = new IterationNodeCompilationStrategy();
    const actionStrategy = new ActionNodeCompilationStrategy();
    const ifStrategy = new IfNodeCompilationStrategy();
    const reviewStrategy = new HumanReviewNodeCompilationStrategy();
    const entries = definition.nodes.map((node) => {
      const declaration = this.registry.get(node.type, node.typeVersion);
      if (
        !iterationStrategy.supports(declaration.manifest) &&
        !ifStrategy.supports(declaration.manifest) &&
        !reviewStrategy.supports(declaration.manifest)
      ) {
        // 目录声明不代表已有执行策略；非 Action 必须在创建执行服务前明确拒绝。
        if (declaration.manifest.executionKind !== 'action')
          throw new WorkflowPublishValidationError('NODE_EXECUTION_KIND_UNSUPPORTED', node.id);
        this.registry.getAction(node.type, node.typeVersion);
      }
      return { node, declaration };
    });
    const iterationEntries = entries.filter((entry) =>
      iterationStrategy.supports(entry.declaration.manifest),
    );
    const ifNodeIds = new Set(
      entries
        .filter((entry) => ifStrategy.supports(entry.declaration.manifest))
        .map((entry) => entry.node.id),
    );
    const reviewNodeIds = new Set(
      entries
        .filter((entry) => reviewStrategy.supports(entry.declaration.manifest))
        .map((entry) => entry.node.id),
    );
    // 所有能力 / 拓扑 / 输出证明均在创建服务或执行节点前完成。
    if (
      iterationEntries.length ||
      reviewNodeIds.size ||
      ifNodeIds.size ||
      definition.nodes.some((node) =>
        Object.values(node.inputs).some((binding) => binding.type === 'candidate'),
      ) ||
      definition.outputs.some((output) => output.sources !== undefined) ||
      definition.edges.some(
        (edge) =>
          edge.kind === 'control' &&
          (edge.source.portKey !== undefined || edge.target.portKey !== undefined),
      )
    ) {
      validateWorkflowDefinitionSemantics(definition, this.registry);
    }
    const ifAnalysis =
      ifNodeIds.size ||
      definition.nodes.some((node) =>
        Object.values(node.inputs).some((binding) => binding.type === 'candidate'),
      ) ||
      definition.outputs.some((output) => output.sources !== undefined)
        ? analyzeSimpleIfExecution(definition, ifNodeIds)
        : undefined;
    const unsupportedReview = findUnsupportedHumanReviewTopology(
      definition,
      reviewNodeIds,
      ifAnalysis?.branchRegions,
    );
    if (unsupportedReview)
      throw new WorkflowPublishValidationError(
        'HUMAN_REVIEW_TOPOLOGY_UNSUPPORTED',
        unsupportedReview,
      );
    const baseBudget = (ifAnalysis ?? analyzeStaticDagExecution(definition)).recursionLimit;
    const recursionLimit = Math.max(
      baseBudget,
      ...iterationEntries.map(({ node }) => iterationRecursionLimit(node)),
    );
    const needsValueServices =
      ifAnalysis !== undefined || reviewNodeIds.size > 0 || iterationEntries.length > 0;
    if (needsValueServices && !this.createValueServices)
      throw new Error('If / Human Review / Iteration 编译必须显式注入 BindingResolver / Codec');
    if (reviewNodeIds.size && !this.createHumanReviewRuns)
      throw new Error('Human Review 编译必须显式注入 NodeRun Repository');
    if (iterationEntries.length && !this.createIterationRuns)
      throw new Error('Iteration 编译必须注入 IterationRun Repository');
    const valueServices = needsValueServices ? await this.createValueServices!(run) : undefined;
    const reviewRuns = reviewNodeIds.size ? await this.createHumanReviewRuns!(run) : undefined;
    const iterationRuns = iterationEntries.length
      ? await this.createIterationRuns!(run)
      : undefined;
    const executor =
      iterationEntries.length ||
      entries.some((entry) => actionStrategy.supports(entry.declaration.manifest))
        ? valueServices
          ? await this.createExecutor(run, valueServices)
          : await this.createExecutor(run)
        : undefined;
    // 动态节点名由已校验的领域定义提供；调度、barrier 与持久化继续由 LangGraph 承担。
    const graph = new StateGraph<
      typeof WorkflowStateAnnotation.spec,
      WorkflowState,
      Partial<WorkflowState>,
      string
    >(WorkflowStateAnnotation);
    for (const { node, declaration } of entries) {
      if (iterationStrategy.supports(declaration.manifest)) {
        if (!executor || !valueServices || !iterationRuns)
          throw new Error('Iteration 执行服务未配置');
        iterationStrategy.compile({
          node,
          declaration,
          workflow: definition,
          run,
          scopeKey: ROOT_EXECUTION_SCOPE_KEY,
          registry: this.registry,
          executor,
          services: valueServices,
          runs: iterationRuns,
          addNode: (id, child) => {
            graph.addNode(id, child);
          },
        });
      } else if (ifStrategy.supports(declaration.manifest)) {
        if (!valueServices) throw new Error('If 执行服务未配置');
        ifStrategy.compile({
          node,
          declaration,
          workflow: definition,
          services: valueServices,
          addNode: (id, action) => {
            graph.addNode(id, action);
          },
        });
      } else if (reviewStrategy.supports(declaration.manifest)) {
        if (!valueServices || !reviewRuns) throw new Error('Human Review 执行服务未配置');
        reviewStrategy.compile({
          node,
          declaration,
          workflow: definition,
          services: valueServices,
          nodeRuns: reviewRuns,
          scopeKey: ROOT_EXECUTION_SCOPE_KEY,
          addNode: (id, action) => {
            graph.addNode(id, action);
          },
        });
      } else {
        if (!executor) throw new Error('Action 执行服务未配置');
        actionStrategy.compile({
          node,
          manifest: declaration.manifest,
          executor,
          executionContext: (config) => ({
            workflow: definition,
            runnableConfig: config,
            scopeKey: ROOT_EXECUTION_SCOPE_KEY,
          }),
          addNode: (id, action) => {
            graph.addNode(id, action);
          },
        });
      }
    }
    const dependencies = collectNodeDependencies(definition.edges, definition.nodes);
    new DependencyCompiler().compile({
      edges: definition.edges,
      nodes: definition.nodes,
      ...(ifAnalysis ? { dependencies: ifAnalysis.staticDependencies } : {}),
      addEdge: (sources, target) => {
        graph.addEdge(sources, target);
      },
    });
    if (ifAnalysis) {
      for (const route of ifAnalysis.routes)
        graph.addConditionalEdges(route.nodeId, (state) => readIfRoute(state, route.nodeId), {
          true: route.true,
          false: route.false,
        });
      for (const id of ifAnalysis.roots) graph.addEdge(START, id);
      for (const id of ifAnalysis.leaves) graph.addEdge(id, END);
    } else {
      const targets = new Set(dependencies.map((dependency) => dependency.targetNodeId));
      const sources = new Set(dependencies.flatMap((dependency) => dependency.sourceNodeIds));
      for (const node of definition.nodes) {
        if (!targets.has(node.id)) graph.addEdge(START, node.id);
        if (!sources.has(node.id)) graph.addEdge(node.id, END);
      }
    }
    if (definition.nodes.length === 0) graph.addEdge(START, END);
    const compiled = graph
      .compile({ checkpointer: this.checkpointer })
      .withConfig({ recursionLimit });
    if (!iterationEntries.length) return compiled;
    return {
      invoke: async (input, config) => {
        assertIterationCompatibility(config);
        return compiled.invoke(input, config);
      },
      getState: (config, options) => compiled.getState(config, options),
    };
  }
}
