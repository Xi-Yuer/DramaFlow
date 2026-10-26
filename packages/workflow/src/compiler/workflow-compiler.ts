import { SubWorkflowNodeCompilationStrategy } from './subworkflow/strategy.js';
import type { ChildGraphRunRepository } from '../runtime/execution/child-execution-repository.js';
import { compileGraph } from './graph/graph-compiler.js';
import { prepareGraphCompilation } from './graph/compilation-plan.js';
import {
  ROOT_EXECUTION_SCOPE_KEY,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@dramaflow/contracts';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  type Command,
  StateGraph,
  type BaseCheckpointSaver,
  type StateSnapshot,
} from '@langchain/langgraph';
import { createWorkflowDefinitionSnapshot } from '../definition/contract/version.js';
import { NodeRegistry } from '../node/registry/registry.js';
import type { HumanReviewNodeRunRepository } from '../runtime/execution/node-run-repository.js';
import type { IterationRunRepository } from './iteration/execution-repository.js';
import type { NodeExecutor } from '../runtime/node/node-executor.js';
import { WorkflowStateAnnotation, type WorkflowState } from '../runtime/state/state.js';
import { ActionNodeCompilationStrategy, type WorkflowValueServices } from './strategy.js';
import { IfNodeCompilationStrategy } from './if/strategy.js';
import { HumanReviewNodeCompilationStrategy } from './human-review/strategy.js';
import { IterationNodeCompilationStrategy } from './iteration/strategy.js';
import { assertIterationCompatibility } from './iteration/compatibility.js';

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
    private readonly createChildGraphRuns?: (run: WorkflowRun) => Promise<ChildGraphRunRepository>,
  ) {}

  async compile(input: WorkflowDefinition, run: WorkflowRun): Promise<CompiledWorkflow> {
    const definition = createWorkflowDefinitionSnapshot(input);
    if (!this.checkpointer) throw new Error('WorkflowCompiler 必须显式注入 Checkpointer');
    const iterationStrategy = new IterationNodeCompilationStrategy();
    const actionStrategy = new ActionNodeCompilationStrategy();
    const ifStrategy = new IfNodeCompilationStrategy();
    const reviewStrategy = new HumanReviewNodeCompilationStrategy();
    const plan = prepareGraphCompilation({
      definition,
      definitionLocation: { workflowVersionId: run.workflowVersionId, path: [] },
      registry: this.registry,
      strategies: {
        action: actionStrategy,
        if: ifStrategy,
        review: reviewStrategy,
        iteration: iterationStrategy,
        subworkflow: new SubWorkflowNodeCompilationStrategy(),
      },
    });
    const recursionLimit = plan.budget.recursionLimit;
    const needsValueServices = plan.requirements.values;
    if (needsValueServices && !this.createValueServices)
      throw new Error('If / Human Review / Iteration 编译必须显式注入 BindingResolver / Codec');
    if (plan.requirements.reviewRuns && !this.createHumanReviewRuns)
      throw new Error('Human Review 编译必须显式注入 NodeRun Repository');
    if (plan.requirements.iterationRuns && !this.createIterationRuns)
      throw new Error('Iteration 编译必须注入 IterationRun Repository');
    if (plan.requirements.childGraphRuns && !this.createChildGraphRuns)
      throw new Error('Composite 编译必须注入 ChildGraphRun Repository');
    const childGraphRuns = plan.requirements.childGraphRuns
      ? await this.createChildGraphRuns!(run)
      : undefined;
    const valueServices = needsValueServices ? await this.createValueServices!(run) : undefined;
    const reviewRuns = plan.requirements.reviewRuns
      ? await this.createHumanReviewRuns!(run)
      : undefined;
    const iterationRuns = plan.requirements.iterationRuns
      ? await this.createIterationRuns!(run)
      : undefined;
    const executor = plan.requirements.executor
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
    compileGraph({
      plan,
      registry: this.registry,
      run,
      execution: { identity: { scopeKey: ROOT_EXECUTION_SCOPE_KEY } },
      runtime: { executor, services: valueServices, reviewRuns, iterationRuns, childGraphRuns },
      target: {
        addNode: (id, execute) => {
          graph.addNode(id, execute);
        },
        addBoundaryNode: (id, execute) => {
          graph.addNode(id, execute);
        },
        addEdge: (sources, target) => {
          graph.addEdge(sources, target);
        },
        addConditionalEdges: (id, route, paths) => {
          graph.addConditionalEdges(id, route, paths);
        },
      },
    });
    const compiled = graph
      .compile({ checkpointer: this.checkpointer })
      .withConfig({ recursionLimit });
    if (!plan.requirements.iterationRuns) return compiled;
    return {
      invoke: async (input, config) => {
        assertIterationCompatibility(config);
        return compiled.invoke(input, config);
      },
      getState: (config, options) => compiled.getState(config, options),
    };
  }
}
