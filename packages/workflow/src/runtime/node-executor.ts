import type {
  NodeDefinition,
  NodeRunError,
  RuntimeValue,
  WorkflowDefinition,
} from '@dramaflow/contracts';
import type { RunnableConfig } from '@langchain/core/runnables';
import { isGraphBubbleUp } from '@langchain/langgraph';
import { NodeRegistry } from '../node/registry.js';
import type { BindingResolver } from './binding-resolver.js';
import { NodeExecutionError, type NodeExecutionStage } from './node-execution-error.js';
import type { RuntimeValueCodec } from './runtime-value-codec.js';
import type { RuntimeValueContext } from './value-codec.js';
import type { WorkflowState } from './state.js';

export interface CapabilityInvoker {
  invoke(capability: string, input: unknown): Promise<unknown>;
}

export interface NodeExecutionContext extends RuntimeValueContext {
  readonly workflow: WorkflowDefinition;
  readonly state: WorkflowState;
  readonly signal?: AbortSignal;
  readonly capabilities?: CapabilityInvoker;
  readonly runnableConfig?: RunnableConfig;
}
export interface NodeExecutionResult {
  readonly output: unknown;
}

export interface NodeExecutor {
  execute(node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult>;
}

export class DefaultNodeExecutor implements NodeExecutor {
  constructor(
    private readonly nodeRegistry: NodeRegistry,
    private readonly bindingResolver: BindingResolver,
    private readonly runtimeValueCodec: RuntimeValueCodec,
  ) {}

  async execute(node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult> {
    let stage: NodeExecutionStage = 'resolve_input';
    try {
      // getAction 复用 get 的精确类型版本查找，并拒绝所有非 action 声明。
      const nodeType = this.nodeRegistry.getAction(node.type, node.typeVersion);
      const runtimeInputs = await this.bindingResolver.resolveInputs({
        node,
        nodeType: nodeType.manifest,
        edges: context.workflow.edges,
        state: context.state,
      });

      stage = 'decode_input';
      const rawInputs = await this.runtimeValueCodec.decodeRecord(runtimeInputs, {
        projectId: context.projectId,
        workflowRunId: context.workflowRunId,
      });

      stage = 'validate_input';
      const input = nodeType.inputSchema.parse(rawInputs);
      stage = 'validate_config';
      const config = nodeType.configSchema.parse(node.config);
      stage = 'execute';
      const rawOutput = await nodeType.execute(input, config, context);
      stage = 'validate_output';
      const output = nodeType.outputSchema.parse(rawOutput);
      return { output };
    } catch (cause) {
      // 中断、父图 Command 等原生控制异常必须交还 LangGraph，不能记为业务失败。
      if (cause !== null && isGraphBubbleUp(cause)) throw cause;
      throw new NodeExecutionError(node.id, node.type, stage, cause);
    }
  }
}

// 与 Checkpoint 分离的业务投影端口。attempt 由 Store 分配，不等同于节点函数重入次数。
export interface NodeRunRecorder {
  begin(
    node: NodeDefinition,
    context: RuntimeValueContext,
  ): Promise<{ id: string; attempt: number }>;
  complete(
    id: string,
    inputs: Record<string, RuntimeValue>,
    outputs: Record<string, RuntimeValue>,
    context: RuntimeValueContext,
  ): Promise<void>;
  fail(id: string, error: NodeRunError, context: RuntimeValueContext): Promise<void>;
}
