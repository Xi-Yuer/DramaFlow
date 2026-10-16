import { z } from 'zod';

export const platformRoleSchema = z.enum(['admin', 'user']);
export const profileInputSchema = z
  .object({
    name: z.string().trim().min(1, '请输入称呼').max(80, '称呼最多 80 个字符'),
    bio: z.string().trim().max(280, '简介最多 280 个字符'),
    timeZone: z
      .string()
      .max(64)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('zh-CN', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, '请选择有效的时区'),
  })
  .strict();
export const currentUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  role: platformRoleSchema,
  createdAt: z.iso.datetime(),
  profile: z.object({ bio: z.string(), locale: z.string(), timeZone: z.string() }),
  session: z.object({ id: z.string(), expiresAt: z.iso.datetime() }),
});
export const sessionSummarySchema = z.object({
  id: z.string(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
});
export type CurrentUser = z.infer<typeof currentUserSchema>;
export type ProfileInput = z.infer<typeof profileInputSchema>;

export * from './workflow.js';
