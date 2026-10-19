import type { NodeDefinition, NodeRunError, RuntimeValue } from '@dramaflow/contracts';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { RuntimeValueContext } from './value-codec.js';
import type { WorkflowState, WorkflowStateUpdate } from './state.js';

export interface CapabilityInvoker {
  invoke(capability: string, input: unknown): Promise<unknown>;
}

export interface NodeExecutionContext extends RuntimeValueContext {
  readonly signal?: AbortSignal;
  readonly capabilities?: CapabilityInvoker;
  readonly runnableConfig?: RunnableConfig;
}
// 执行管线的服务契约；实际 Binding、Codec、NodeRun/Artifact 持久化由后续运行服务组装。
export interface NodeExecutor {
  execute(parameters: {
    node: NodeDefinition;
    state: WorkflowState;
    context: NodeExecutionContext;
  }): Promise<WorkflowStateUpdate>;
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
