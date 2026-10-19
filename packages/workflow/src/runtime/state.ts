import type { NodeOutputMap, RuntimeValue } from '@dramaflow/contracts';
export interface WorkflowRunContext {
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly workflowRunId: string;
  readonly projectId: string;
}
// 这是值协议，不创建 LangGraph Channel、reducer 或分支调度规则。
export interface WorkflowState {
  readonly run: WorkflowRunContext;
  readonly inputs: Readonly<Record<string, RuntimeValue>>;
  readonly outputs: NodeOutputMap;
  readonly variables: Readonly<Record<string, RuntimeValue>>;
  readonly execution: Readonly<Record<string, never>>;
}
export interface WorkflowStateUpdate {
  outputs: NodeOutputMap;
}
