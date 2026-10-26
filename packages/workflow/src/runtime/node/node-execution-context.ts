import type { WorkflowDefinition } from '@dramaflow/contracts';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { WorkflowState } from '../state/state.js';
import type { RuntimeValueContext } from '../values/value-codec.js';

export interface CapabilityInvoker {
  invoke(capability: string, input: unknown): Promise<unknown>;
}

// 节点 execute 只看见这次调用的上下文，不依赖 Executor 实现。
export interface NodeExecutionContext extends RuntimeValueContext {
  readonly scopeKey: string;
  readonly childExecutionId?: string;
  readonly workflow: WorkflowDefinition;
  readonly state: WorkflowState;
  readonly signal?: AbortSignal;
  readonly capabilities?: CapabilityInvoker;
  readonly runnableConfig?: RunnableConfig;
}
