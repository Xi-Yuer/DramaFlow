import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { WorkspaceRole } from '@dramaflow/database';
import { DatabaseService } from '../infrastructure/database.service.js';

const rank: Record<WorkspaceRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

@Injectable()
export class AccessService {
  constructor(private readonly db: DatabaseService) {}
  async workspace(
    userId: string,
    workspaceId: string,
    minimum: WorkspaceRole = 'viewer',
  ) {
    const member = await this.db.client.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new NotFoundException('工作空间不存在或无权访问');
    if (rank[member.role] < rank[minimum])
      throw new ForbiddenException('当前角色无权执行此操作');
    return member;
  }
  async workflow(
    userId: string,
    workflowId: string,
    minimum: WorkspaceRole = 'viewer',
  ) {
    const workflow = await this.db.client.workflow.findUnique({
      where: { id: workflowId },
    });
    if (!workflow) throw new NotFoundException('工作流不存在');
    await this.workspace(userId, workflow.workspaceId, minimum);
    return workflow;
  }
  async run(userId: string, runId: string, minimum: WorkspaceRole = 'viewer') {
    const run = await this.db.client.run.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('运行不存在');
    await this.workspace(userId, run.workspaceId, minimum);
    return run;
  }
}
