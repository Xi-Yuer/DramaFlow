import type { WorkflowDefinition, WorkflowRun } from '@dramaflow/contracts';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  END,
  type Command,
  START,
  StateGraph,
  type BaseCheckpointSaver,
  type StateSnapshot,
} from '@langchain/langgraph';
import { validateWorkflowDefinitionSemantics } from '../definition/validate-publish.js';
import { createWorkflowDefinitionSnapshot } from '../definition/version.js';
import { NodeRegistry } from '../node/registry.js';
import type { NodeExecutor } from '../runtime/node-executor.js';
import { WorkflowStateAnnotation, type WorkflowState } from '../runtime/state.js';
import { collectNodeDependencies, DependencyCompiler } from './dependency.compiler.js';
import { ActionNodeCompilationStrategy } from './strategy.js';
import { IfNodeCompilationStrategy, readIfRoute, type IfExecutionServices } from './if/strategy.js';
import { analyzeSimpleIfExecution } from './if/analysis.js';
import { analyzeActionDagExecution } from './action-dag-execution-analysis.js';

// Runner 仅发送 resume，不开放 Command.update / goto 的状态写入或路由能力。
export type WorkflowResumeCommand = Command<unknown, never, never>;
export interface CompiledWorkflow {
  invoke(input: WorkflowState | WorkflowResumeCommand, config: RunnableConfig): Promise<unknown>;
  getState(config: RunnableConfig): Promise<StateSnapshot>;
}

export interface WorkflowCompiler {
  compile(definition: WorkflowDefinition, run: WorkflowRun): Promise<CompiledWorkflow>;
}

// 显式创建限定本次运行权限的 Executor，不在 Compiler 中读写运行状态或选择 thread。
export type NodeExecutorFactory = (
  run: WorkflowRun,
  ifServices?: IfExecutionServices,
) => Promise<NodeExecutor>;
export type IfExecutionServicesFactory = (run: WorkflowRun) => Promise<IfExecutionServices>;

export class DefaultWorkflowCompiler implements WorkflowCompiler {
  constructor(
    private readonly registry: NodeRegistry,
    private readonly createExecutor: NodeExecutorFactory,
    private readonly checkpointer: BaseCheckpointSaver,
    private readonly createIfServices?: IfExecutionServicesFactory,
  ) {}

  async compile(input: WorkflowDefinition, run: WorkflowRun): Promise<CompiledWorkflow> {
    const definition = createWorkflowDefinitionSnapshot(input);
    if (!this.checkpointer) throw new Error('WorkflowCompiler 必须显式注入 Checkpointer');
    const actionStrategy = new ActionNodeCompilationStrategy();
    const ifStrategy = new IfNodeCompilationStrategy();
    const entries = definition.nodes.map((node) => {
      const declaration = this.registry.get(node.type, node.typeVersion);
      if (!ifStrategy.supports(declaration.manifest))
        this.registry.getAction(node.type, node.typeVersion);
      return { node, declaration };
    });
    const ifNodeIds = new Set(
      entries
        .filter((entry) => ifStrategy.supports(entry.declaration.manifest))
        .map((entry) => entry.node.id),
    );
    // 所有能力 / 拓扑 / 输出证明均在创建服务或执行节点前完成。
    if (
      ifNodeIds.size ||
      definition.edges.some(
        (edge) =>
          edge.kind === 'control' &&
          (edge.source.portKey !== undefined || edge.target.portKey !== undefined),
      )
    ) {
      validateWorkflowDefinitionSemantics(definition, this.registry);
    }
    const ifAnalysis = ifNodeIds.size ? analyzeSimpleIfExecution(definition, ifNodeIds) : undefined;
    const { recursionLimit } = ifAnalysis ?? analyzeActionDagExecution(definition);
    if (ifAnalysis && !this.createIfServices)
      throw new Error('If 编译必须显式注入 BindingResolver / Codec');
    const ifServices = ifAnalysis ? await this.createIfServices!(run) : undefined;
    const executor = ifServices
      ? await this.createExecutor(run, ifServices)
      : await this.createExecutor(run);
    // 动态节点名由已校验的领域定义提供；调度、barrier 与持久化继续由 LangGraph 承担。
    const graph = new StateGraph<
      typeof WorkflowStateAnnotation.spec,
      WorkflowState,
      Partial<WorkflowState>,
      string
    >(WorkflowStateAnnotation);
    for (const { node, declaration } of entries) {
      if (ifStrategy.supports(declaration.manifest)) {
        if (!ifServices) throw new Error('If 执行服务未配置');
        ifStrategy.compile({
          node,
          declaration,
          workflow: definition,
          services: ifServices,
          addNode: (id, action) => {
            graph.addNode(id, action);
          },
        });
      } else {
        actionStrategy.compile({
          node,
          manifest: declaration.manifest,
          executor,
          executionContext: (config) => ({ workflow: definition, runnableConfig: config }),
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
    return graph.compile({ checkpointer: this.checkpointer }).withConfig({ recursionLimit });
  }
}
