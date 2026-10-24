import type { NodeOccurrence, NodeRun, NodeRunError, RuntimeValue } from '@dramaflow/contracts';

export interface GetNodeOccurrenceInput {
  readonly workflowRunId: string;
  readonly nodeId: string;
  readonly scopeKey: string;
}

export interface CreateNodeRunInput {
  readonly workflowRunId: string;
  readonly nodeId: string;
  readonly occurrenceId: string;
}

export interface NodeOccurrenceRepository {
  getOrCreateOccurrence(input: GetNodeOccurrenceInput): Promise<NodeOccurrence>;
}

// 实现须限定项目 / 运行权限，原子分配 attempt；不得修改已结束的记录。
export interface NodeRunRepository extends NodeOccurrenceRepository {
  createRunning(input: CreateNodeRunInput): Promise<NodeRun>;
  updateInputs(nodeRunId: string, inputs: Record<string, RuntimeValue>): Promise<void>;
  markCompleted(nodeRunId: string, outputs: Record<string, RuntimeValue>): Promise<void>;
  markFailed(nodeRunId: string, error: NodeRunError): Promise<void>;
}

// 暂停重入复用同一 occurrence 的 running attempt，不按 nodeId 或 latest attempt 猜身份。
export interface HumanReviewNodeRunRepository extends NodeRunRepository {
  getOrCreateHumanReviewRunning(
    input: CreateNodeRunInput & { readonly workflowVersionId: string },
  ): Promise<NodeRun>;
}
