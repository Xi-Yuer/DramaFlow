import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';

export interface AuthenticatedRequest extends Request {
  actor: { id: string; email: string; name: string };
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly service: AuthService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = await this.service.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    if (!session) throw new UnauthorizedException('请先登录');
    request.actor = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    };
    return true;
  }
}

export const Actor = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().actor,
);
export type ActorValue = AuthenticatedRequest['actor'];
