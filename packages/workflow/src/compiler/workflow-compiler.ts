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
import { createWorkflowDefinitionSnapshot } from '../definition/version.js';
import { NodeRegistry } from '../node/registry.js';
import type { NodeExecutor } from '../runtime/node-executor.js';
import { WorkflowStateAnnotation, type WorkflowState } from '../runtime/state.js';
import { collectNodeDependencies, DependencyCompiler } from './dependency.compiler.js';
import { ActionNodeCompilationStrategy } from './strategy.js';

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
export type NodeExecutorFactory = (run: WorkflowRun) => Promise<NodeExecutor>;

export class DefaultWorkflowCompiler implements WorkflowCompiler {
  constructor(
    private readonly registry: NodeRegistry,
    private readonly createExecutor: NodeExecutorFactory,
    private readonly checkpointer: BaseCheckpointSaver,
  ) {}

  async compile(input: WorkflowDefinition, run: WorkflowRun): Promise<CompiledWorkflow> {
    const definition = createWorkflowDefinitionSnapshot(input);
    if (!this.checkpointer) throw new Error('WorkflowCompiler 必须显式注入 Checkpointer');
    const executor = await this.createExecutor(run);
    // 动态节点名由已校验的领域定义提供；调度、barrier 与持久化继续由 LangGraph 承担。
    const graph = new StateGraph<
      typeof WorkflowStateAnnotation.spec,
      WorkflowState,
      Partial<WorkflowState>,
      string
    >(WorkflowStateAnnotation);
    const strategy = new ActionNodeCompilationStrategy();
    for (const node of definition.nodes) {
      const nodeType = this.registry.getAction(node.type, node.typeVersion);
      strategy.compile({
        node,
        manifest: nodeType.manifest,
        executor,
        executionContext: (config) => ({ workflow: definition, runnableConfig: config }),
        addNode: (id, action) => {
          graph.addNode(id, action);
        },
      });
    }
    const dependencies = collectNodeDependencies(definition.edges, definition.nodes);
    new DependencyCompiler().compile({
      edges: definition.edges,
      nodes: definition.nodes,
      addEdge: (sources, target) => {
        graph.addEdge(sources, target);
      },
    });
    const targets = new Set(dependencies.map((dependency) => dependency.targetNodeId));
    const sources = new Set(dependencies.flatMap((dependency) => dependency.sourceNodeIds));
    for (const node of definition.nodes) {
      if (!targets.has(node.id)) graph.addEdge(START, node.id);
      if (!sources.has(node.id)) graph.addEdge(node.id, END);
    }
    if (definition.nodes.length === 0) graph.addEdge(START, END);
    return graph.compile({ checkpointer: this.checkpointer });
  }
}
