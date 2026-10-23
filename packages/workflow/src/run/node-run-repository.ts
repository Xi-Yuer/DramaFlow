import type { NodeRun, NodeRunError, RuntimeValue } from '@dramaflow/contracts';

export interface CreateNodeRunInput {
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

// 仅适用于当前无环、每个 Human Review node 每 Run 只逻辑执行一次的能力边界。
// 未来 Loop / Iteration 必须增加显式 occurrence identity，不能沿用此键。
export interface HumanReviewNodeRunRepository extends NodeRunRepository {
  getOrCreateHumanReviewRunning(
    input: CreateNodeRunInput & { readonly workflowVersionId: string },
  ): Promise<NodeRun>;
}
