import {
  workflowDefinitionSchema,
  workflowIdentifierSchema,
  workflowVersionMetadataSchema,
  type WorkflowRun,
} from '@dramaflow/contracts';
import { z } from 'zod';
import { createWorkflowDefinitionSnapshot } from '../../definition/contract/version.js';

// 读取完整的已发布版本及归属，不能仅返回无法核对项目 / 工作流身份的 Definition。
export const workflowVersionRecordSchema = workflowVersionMetadataSchema.extend({
  projectId: workflowIdentifierSchema,
  definition: workflowDefinitionSchema,
});
export type WorkflowVersionRecord = z.infer<typeof workflowVersionRecordSchema>;

export interface WorkflowVersionRepository {
  // 实现须在已授权范围内读取不可变版本；不存在或无权访问返回 null，不解析 draft 或 latest。
  getVersion(workflowVersionId: string): Promise<WorkflowVersionRecord | null>;
}

// 提交与执行都核对固定版本归属；执行时重新从存储读取，不依赖提交阶段的内存对象。
export async function loadWorkflowVersion(
  versions: WorkflowVersionRepository,
  identity: Pick<WorkflowRun, 'projectId' | 'workflowId' | 'workflowVersionId'>,
): Promise<WorkflowVersionRecord> {
  const stored = await versions.getVersion(identity.workflowVersionId);
  if (stored === null) throw new Error('工作流版本不存在或无权访问');
  const loaded = workflowVersionRecordSchema.parse(stored);
  if (
    loaded.id !== identity.workflowVersionId ||
    loaded.workflowId !== identity.workflowId ||
    loaded.projectId !== identity.projectId
  )
    throw new Error('工作流版本与请求的项目 / 工作流不匹配');
  return Object.freeze({
    ...loaded,
    definition: createWorkflowDefinitionSnapshot(loaded.definition),
  });
}
