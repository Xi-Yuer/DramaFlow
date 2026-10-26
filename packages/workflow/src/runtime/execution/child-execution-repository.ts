import type { NodeRunRepository } from './node-run-repository.js';
import type { ChildExecution, NodeRunError } from '@dramaflow/contracts';

export interface CreateChildExecutionInput {
  readonly workflowRunId: string;
  readonly parentNodeRunId: string;
  readonly parentNodeId: string;
  readonly scopeKey: string;
  readonly kind: string;
  readonly invocationKey: string;
  readonly metadata: ChildExecution['metadata'];
}
// 实例始终限定授权 Run；同一父 attempt + invocationKey 原子复用。
export interface ChildExecutionRepository {
  getOrCreateChildExecutionRunning(input: CreateChildExecutionInput): Promise<ChildExecution>;
  getChildExecutionById(id: string): Promise<ChildExecution | null>;
  markChildExecutionCompleted(id: string): Promise<void>;
  markChildExecutionFailed(id: string, error: NodeRunError): Promise<void>;
  markChildExecutionAndParentFailed(id: string, error: NodeRunError): Promise<void>;
}

export interface ChildGraphRunRepository extends NodeRunRepository, ChildExecutionRepository {}
