import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { admin } from 'better-auth/plugins';
import type { PrismaClient } from '@dramaflow/database';

export function createAuth(db: PrismaClient) {
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseURL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
  if (!secret || secret.length < 32)
    throw new Error('BETTER_AUTH_SECRET 至少需要 32 个字符');
  return betterAuth({
    appName: 'DramaFlow',
    secret,
    baseURL,
    trustedOrigins: [new URL(baseURL).origin],
    database: prismaAdapter(db, { provider: 'postgresql', transaction: true }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    user: { changeEmail: { enabled: false }, deleteUser: { enabled: false } },
    advanced: {
      database: { generateId: () => randomUUID() },
      useSecureCookies: new URL(baseURL).protocol === 'https:',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
      ipAddress: { ipAddressHeaders: ['x-real-ip'] },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 120,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/change-password': { window: 60, max: 5 },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path === '/change-password') {
          return {
            context: {
              body: { ...context.body, revokeOtherSessions: true },
            },
          };
        }
      }),
    },
    plugins: [
      admin({
        defaultRole: 'user',
        adminRoles: ['admin'],
        bannedUserMessage: '账号已停用，请联系管理员',
      }),
    ],
    telemetry: { enabled: false },
  });
}
