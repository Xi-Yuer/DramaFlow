import {
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
  type CanActivate,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService, type AuthActor } from './auth.service.js';
import {
  invalidOriginMessage,
  isUntrustedWriteOrigin,
} from './trusted-origin.js';

export const Public = () => SetMetadata('auth:public', true);
export const PlatformAdmin = () => SetMetadata('auth:role', 'admin');
export type AuthRequest = Request & { actor?: AuthActor };
export const Actor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthActor => {
    const actor = context.switchToHttp().getRequest<AuthRequest>().actor;
    if (!actor) throw new UnauthorizedException('请先登录');
    return actor;
  },
);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    if (
      this.reflector.getAllAndOverride<boolean>('auth:public', [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest<AuthRequest>();
    request.actor = await this.auth.requireSession(request);
    if (isUntrustedWriteOrigin(request.method, request.headers.origin))
      throw new ForbiddenException(invalidOriginMessage);
    if (
      this.reflector.getAllAndOverride<string>('auth:role', [
        context.getHandler(),
        context.getClass(),
      ]) === 'admin' &&
      request.actor.user.role !== 'admin'
    )
      throw new ForbiddenException('需要平台管理员权限');
    return true;
  }
}
