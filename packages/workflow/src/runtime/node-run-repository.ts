import type { NodeRun, NodeRunError, RuntimeValue } from '@dramaflow/contracts';

export interface CreateNodeRunInput {
  readonly projectId: string;
  readonly workflowRunId: string;
  readonly nodeId: string;
}

// 实现须限定项目 / 运行权限，原子分配 attempt；不得修改已结束的记录。
export interface NodeRunRepository {
  createRunning(input: CreateNodeRunInput): Promise<NodeRun>;
  updateInputs(nodeRunId: string, inputs: Record<string, RuntimeValue>): Promise<void>;
  markCompleted(nodeRunId: string, outputs: Record<string, RuntimeValue>): Promise<void>;
  markFailed(nodeRunId: string, error: NodeRunError): Promise<void>;
}
