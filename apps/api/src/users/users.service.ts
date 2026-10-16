import { Injectable } from '@nestjs/common';
import { currentUserSchema, profileInputSchema } from '@dramaflow/contracts';
import { DatabaseService } from '../infrastructure/database.service.js';
import type { AuthActor } from '../auth/auth.service.js';

@Injectable()
export class UsersService {
  constructor(private readonly db: DatabaseService) {}
  async me(actor: AuthActor) {
    const profile = await this.db.client.userProfile.findUnique({
      where: { userId: actor.user.id },
    });
    return currentUserSchema.parse({
      id: actor.user.id,
      name: actor.user.name,
      email: actor.user.email,
      image: actor.user.image,
      emailVerified: actor.user.emailVerified,
      role: actor.user.role,
      createdAt: actor.user.createdAt.toISOString(),
      profile: profile
        ? {
            bio: profile.bio,
            locale: profile.locale,
            timeZone: profile.timeZone,
          }
        : { bio: '', locale: 'zh-CN', timeZone: 'Asia/Shanghai' },
      session: {
        id: actor.session.id,
        expiresAt: new Date(actor.session.expiresAt).toISOString(),
      },
    });
  }
  async update(actor: AuthActor, body: unknown) {
    const input = profileInputSchema.parse(body);
    await this.db.client.$transaction([
      this.db.client.user.update({
        where: { id: actor.user.id },
        data: { name: input.name },
      }),
      this.db.client.userProfile.upsert({
        where: { userId: actor.user.id },
        create: {
          userId: actor.user.id,
          bio: input.bio,
          timeZone: input.timeZone,
        },
        update: { bio: input.bio, timeZone: input.timeZone },
      }),
    ]);
    return this.me({ ...actor, user: { ...actor.user, name: input.name } });
  }
  async sessions(actor: AuthActor) {
    const sessions = await this.db.client.session.findMany({
      where: { userId: actor.user.id, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      items: sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        current: session.id === actor.session.id,
      })),
    };
  }
  async revokeOtherSessions(actor: AuthActor) {
    await this.db.client.session.deleteMany({
      where: { userId: actor.user.id, id: { not: actor.session.id } },
    });
    return { success: true };
  }
  async directory() {
    // 平台管理员查看账号目录，不返回凭证、会话 token 或个人简介。
    return {
      items: await this.db.client.user.findMany({
        select: { id: true, name: true, email: true, role: true, banned: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    };
  }
}
