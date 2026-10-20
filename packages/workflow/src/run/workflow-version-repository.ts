import {
  workflowDefinitionSchema,
  workflowIdentifierSchema,
  workflowVersionMetadataSchema,
} from '@dramaflow/contracts';
import { z } from 'zod';

// 读取完整的已发布版本及归属，不能仅返回无法核对项目 / 工作流身份的 Definition。
export const workflowVersionRecordSchema = workflowVersionMetadataSchema.extend({
  projectId: workflowIdentifierSchema,
  definition: workflowDefinitionSchema,
});
export type WorkflowVersionRecord = z.infer<typeof workflowVersionRecordSchema>;

export interface WorkflowVersionRepository {
  // 实现须在已授权范围内读取不可变版本；不解析 draft 或 latest。
  getVersion(workflowVersionId: string): Promise<WorkflowVersionRecord>;
}
