import type { ChildExecution, NodeRunError } from '@dramaflow/contracts';
import type { ChildExecutionRepository } from '../../runtime/execution/child-execution-repository.js';
import type { NodeRunRepository } from '../../runtime/execution/node-run-repository.js';

export interface CreateIterationItemRunInput {
  readonly workflowRunId: string;
  readonly parentNodeRunId: string;
  readonly parentNodeId: string;
  readonly scopeKey: string;
  readonly index: number;
}
export function iterationItemInvocationKey(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Iteration index 无效');
  return `iteration-item:${index}`;
}
// 只保留 Iteration 的结构策略；所有归属和生命周期基于通用 ChildExecution。
export interface IterationRunRepository extends NodeRunRepository, ChildExecutionRepository {
  getOrCreateIterationItemRunning(input: CreateIterationItemRunInput): Promise<ChildExecution>;
  markIterationItemCompleted(id: string): Promise<void>;
  // 延续现有 Iteration 失败传播：同事务结束 child 和父 NodeRun。
  markIterationItemFailed(id: string, error: NodeRunError): Promise<void>;
}
