import {
  workflowRunMetadataSchema,
  workflowVersionMetadataSchema,
  type WorkflowRunMetadata,
  type WorkflowVersionMetadata,
} from '@dramaflow/contracts';
import type { RunnableConfig } from '@langchain/core/runnables';
import { assertWorkflowRunVersion } from './contracts.js';

// 服务端为根 Run 绑定 LangGraph thread；不创建任务、不选择 Checkpointer、不执行或恢复图。
export function createWorkflowRunConfig(
  runInput: WorkflowRunMetadata,
  versionInput: WorkflowVersionMetadata,
  config: RunnableConfig = {},
): RunnableConfig {
  const run = workflowRunMetadataSchema.parse(runInput);
  const version = workflowVersionMetadataSchema.parse(versionInput);
  assertWorkflowRunVersion(run, version);
  const threadId: unknown = config.configurable?.thread_id;
  if (threadId !== undefined && threadId !== run.threadId) {
    throw new Error('LangGraph thread_id 必须与 WorkflowRun.threadId 一致');
  }
  return { ...config, configurable: { ...config.configurable, thread_id: run.threadId } };
}
