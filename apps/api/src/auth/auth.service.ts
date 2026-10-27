import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { DatabaseService } from '@dramaflow/server';
import { createAuth } from './auth.factory.js';

@Injectable()
export class AuthService {
  readonly auth;
  constructor(private readonly db: DatabaseService) {
    this.auth = createAuth(db.client);
  }

  async requireSession(request: Request) {
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
      query: { disableCookieCache: true, disableRefresh: true },
    });
    if (!session) throw new UnauthorizedException('请先登录');
    // 权限与停用状态每次读取数据库，不能依赖前端状态或缓存中的用户资料。
    const user = await this.db.client.user.findUnique({
      where: { id: session.user.id },
    });
    if (!user) throw new UnauthorizedException('会话已失效，请重新登录');
    if (user.banned && (!user.banExpires || user.banExpires.getTime() > Date.now()))
      throw new ForbiddenException('账号已停用，请联系管理员');
    return { user, session: session.session };
  }
}
export type AuthActor = Awaited<ReturnType<AuthService['requireSession']>>;
