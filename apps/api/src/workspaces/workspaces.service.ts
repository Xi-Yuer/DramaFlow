import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../infrastructure/database.service.js';
import { AccessService } from '../auth/access.service.js';
import { AuthService } from '../auth/auth.service.js';
import { parse } from '../infrastructure/validation.js';

const memberSchema = z
  .object({
    email: z.email(),
    name: z.string().min(1).max(100),
    password: z.string().min(12).max(128).optional(),
    role: z.enum(['admin', 'editor', 'viewer']),
  })
  .strict();

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly auth: AuthService,
  ) {}
  async list(userId: string) {
    const memberships = await this.db.client.workspaceMember.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });
    return {
      items: memberships.map(({ workspace, role }) => ({
        id: workspace.id,
        name: workspace.name,
        role: role === 'owner' ? 'admin' : role,
      })),
    };
  }
  async members(userId: string, workspaceId: string) {
    await this.access.workspace(userId, workspaceId, 'admin');
    const members = await this.db.client.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    return { items: members.map(({ user, role }) => ({ ...user, role })) };
  }
  async addMember(userId: string, workspaceId: string, body: unknown) {
    await this.access.workspace(userId, workspaceId, 'admin');
    const input = parse(memberSchema, body);
    let user = await this.db.client.user.findUnique({
      where: { email: input.email },
    });
    if (!user) {
      if (!input.password)
        throw new NotFoundException('账号不存在，请为新成员设置初始密码');
      const id = await this.auth.provisionUser(
        input.email,
        input.password,
        input.name,
      );
      user = await this.db.client.user.findUniqueOrThrow({ where: { id } });
    }
    const existing = await this.db.client.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
    });
    if (existing) throw new ConflictException('成员已在此工作空间');
    return this.db.client.workspaceMember.create({
      data: { workspaceId, userId: user.id, role: input.role },
      select: { userId: true, role: true },
    });
  }
  async updateRole(
    actorId: string,
    workspaceId: string,
    targetId: string,
    body: unknown,
  ) {
    const actor = await this.access.workspace(actorId, workspaceId, 'admin');
    const input = parse(
      z.object({ role: z.enum(['admin', 'editor', 'viewer']) }).strict(),
      body,
    );
    const member = await this.db.client.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetId } },
    });
    if (!member) throw new NotFoundException('成员不存在');
    if (
      member.role === 'owner' ||
      (member.role === 'admin' && actor.role !== 'owner')
    )
      throw new ForbiddenException(
        '仅所有者可以管理管理员；所有者角色不可通过此接口修改',
      );
    return this.db.client.workspaceMember.update({
      where: { id: member.id },
      data: { role: input.role },
      select: { userId: true, role: true },
    });
  }
}
