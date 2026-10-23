import {
  nodeDefinitionSchema,
  nodeTypeManifestSchema,
  type NodeDefinition,
  type NodeTypeManifest,
} from '@dramaflow/contracts';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { NodeExecutor, NodeExecutionContext } from '../runtime/node-executor.js';
import type { WorkflowState, WorkflowStateUpdate } from '../runtime/state.js';

// 每个节点只返回自己的输出增量，合并与冲突检查交给 State 通道。
export type LangGraphNode = (
  state: WorkflowState,
  config: LangGraphRunnableConfig,
) => Promise<WorkflowStateUpdate>;
export interface NodeCompilationContext {
  node: NodeDefinition;
  manifest: NodeTypeManifest;
  executor: NodeExecutor;
  executionContext(
    config: LangGraphRunnableConfig,
  ): Omit<NodeExecutionContext, 'state' | 'projectId' | 'workflowRunId'>;
  addNode(id: string, node: LangGraphNode): void;
}
export interface NodeCompilationStrategy<Context = NodeCompilationContext> {
  supports(manifest: NodeTypeManifest): boolean;
  compile(context: Context): void;
}
export class ActionNodeCompilationStrategy implements NodeCompilationStrategy {
  supports(manifest: NodeTypeManifest): boolean {
    return manifest.executionKind === 'action';
  }
  compile(context: NodeCompilationContext): void {
    const manifest = nodeTypeManifestSchema.parse(context.manifest);
    const node = nodeDefinitionSchema.parse(context.node);
    if (!this.supports(manifest)) throw new Error('action 策略不能编译控制、复合或交互结构');
    if (node.type !== manifest.type || node.typeVersion !== manifest.version)
      throw new Error('编译节点类型版本不匹配');
    const { executor } = context;
    context.addNode(node.id, async (state, config) => {
      const result = await executor.execute(node, {
        ...context.executionContext(config),
        state,
        projectId: state.run.projectId,
        workflowRunId: state.run.workflowRunId,
      });
      return { outputs: { [node.id]: result.output } };
    });
  }
}
