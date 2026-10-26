import type { IterationItemRun, NodeRunError } from '@dramaflow/contracts';
import type { NodeRunRepository } from './node-run-repository.js';

export interface CreateIterationItemRunInput {
  readonly workflowRunId: string;
  readonly iterationNodeRunId: string;
  readonly iterationNodeId: string;
  readonly scopeKey: string;
  readonly index: number;
}

// 限定授权 Run；同一父 attempt / index 在 checkpoint 重入时复用 running 身份。
export interface IterationRunRepository extends NodeRunRepository {
  getOrCreateIterationItemRunning(input: CreateIterationItemRunInput): Promise<IterationItemRun>;
  markIterationItemCompleted(id: string): Promise<void>;
  // 同事务记录 item 与父 NodeRun 失败；并行失败只结束各自 item，不覆盖父终态。
  markIterationItemFailed(id: string, error: NodeRunError): Promise<void>;
}
