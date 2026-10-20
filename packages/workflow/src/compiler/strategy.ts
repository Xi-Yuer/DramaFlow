import {
  nodeDefinitionSchema,
  nodeTypeManifestSchema,
  type NodeDefinition,
  type NodeTypeManifest,
} from '@dramaflow/contracts';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from '../runtime/node-executor.js';
import type { WorkflowState } from '../runtime/state.js';

// 本阶段返回业务执行结果；输出 encode 与 WorkflowState 增量适配尚未接入。
export type LangGraphNode = (
  state: WorkflowState,
  config: LangGraphRunnableConfig,
) => Promise<NodeExecutionResult>;
export interface NodeCompilationContext {
  node: NodeDefinition;
  manifest: NodeTypeManifest;
  executor: NodeExecutor;
  executionContext(config: LangGraphRunnableConfig): Omit<NodeExecutionContext, 'state'>;
  addNode(id: string, node: LangGraphNode): void;
}
export interface NodeCompilationStrategy {
  supports(manifest: NodeTypeManifest): boolean;
  compile(context: NodeCompilationContext): void;
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
    context.addNode(node.id, (state, config) =>
      executor.execute(nodeDefinitionSchema.parse(node), {
        ...context.executionContext(config),
        state,
      }),
    );
  }
}
