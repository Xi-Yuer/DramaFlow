import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { toNodeHandler } from 'better-auth/node';
import type { Express } from 'express';
import type { AuthService } from './auth.service.js';
import { invalidOriginMessage, isUntrustedWriteOrigin } from './trusted-origin.js';

// 不公开管理员插件、注册、账号删除、模拟登录等尚未授权的 HTTP 能力。
const exposed = new Set(['sign-in/email', 'sign-out', 'get-session', 'change-password']);
export function mountAuth(server: Express, service: AuthService) {
  const trustedProxies =
    process.env.TRUSTED_PROXY_CIDRS?.split(',')
      .map((item) => item.trim())
      .filter(Boolean) ?? [];
  server.set('trust proxy', trustedProxies.length ? trustedProxies : false);
  const handler = toNodeHandler(service.auth);
  server.all('/api/auth/{*path}', async (request, response, next) => {
    try {
      const path = request.path.slice('/api/auth/'.length);
      if (!exposed.has(path)) {
        response.status(404).json({
          code: 'AUTH_ENDPOINT_DISABLED',
          message: '此认证入口未开放',
        });
        return;
      }
      if (isUntrustedWriteOrigin(request.method, request.headers.origin)) {
        response.status(403).json({
          code: 'INVALID_ORIGIN',
          message: invalidOriginMessage,
        });
        return;
      }
      request.headers['x-real-ip'] = request.ip ?? request.socket.remoteAddress ?? 'unknown';
      response.setHeader('Cache-Control', 'no-store');
      // 不让已停用账号利用认证组件的内建接口绕过平台 Guard。
      if (path !== 'sign-in/email' && path !== 'sign-out') {
        if (request.headers.cookie) {
          try {
            await service.requireSession(request);
          } catch (error) {
            if (error instanceof ForbiddenException) {
              response.status(403).json({
                code: 'ACCOUNT_DISABLED',
                message: '账号已停用，请联系管理员',
              });
              return;
            }
            if (!(error instanceof UnauthorizedException)) throw error;
          }
        }
      }
      await handler(request, response);
    } catch (error) {
      next(error);
    }
  });
}
