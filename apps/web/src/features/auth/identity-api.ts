import { currentUserSchema, sessionSummarySchema, type ProfileInput } from '@dramaflow/contracts';
import { z } from 'zod';
import { jsonBody, request } from '@/lib/http';

export const identityKey = ['identity', 'me'] as const;
export const sessionsKey = ['identity', 'sessions'] as const;
export const identityApi = {
  me: () => request('/users/me', currentUserSchema),
  update: (input: ProfileInput) =>
    request('/users/me', currentUserSchema, { method: 'PATCH', body: jsonBody(input) }),
  sessions: () => request('/users/me/sessions', z.object({ items: z.array(sessionSummarySchema) })),
  revokeOthers: () =>
    request('/users/me/revoke-other-sessions', z.object({ success: z.boolean() }), {
      method: 'POST',
      body: '{}',
    }),
};
export function authErrorMessage(error: { code?: string; status?: number } | null) {
  if (error?.status === 429) return '登录尝试过于频繁，请稍后再试。';
  if (error?.code === 'BANNED_USER') return '账号已停用，请联系管理员。';
  if (error?.code === 'INVALID_EMAIL_OR_PASSWORD') return '邮箱或密码不正确，请重新输入。';
  if (error?.code === 'INVALID_PASSWORD') return '当前密码不正确。';
  return '暂时无法完成操作，请稍后重试。';
}
