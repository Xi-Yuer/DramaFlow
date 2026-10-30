import { z } from 'zod';

export const viewportSchema = z
  .object({
    x: z.number().finite().min(-1_000_000).max(1_000_000),
    y: z.number().finite().min(-1_000_000).max(1_000_000),
    zoom: z.number().finite().min(0.1).max(3),
  })
  .strict();
export const createProjectSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export const saveProjectSchema = z
  .object({
    revision: z.number().int().positive(),
    name: createProjectSchema.shape.name,
  })
  .strict();
export const projectSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    revision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const projectSchema = projectSummarySchema;
const projectPageCursorTokenSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, '项目游标必须是未填充的 base64url');
export const projectListQuerySchema = z
  .object({ cursor: projectPageCursorTokenSchema.optional() })
  .strict();
export const projectListSchema = z
  .object({
    items: z.array(projectSummarySchema),
    nextCursor: projectPageCursorTokenSchema.nullable(),
  })
  .strict();
const projectPageCursorSchema = z
  .object({
    // 数据库列为 TIMESTAMP(3)，Date 及服务端生成的游标同样使用毫秒精度。
    updatedAt: z.iso.datetime({ precision: 3 }),
    id: z.uuid(),
  })
  .strict();
export type Project = z.infer<typeof projectSchema>;
export type SaveProject = z.infer<typeof saveProjectSchema>;
export type ProjectPageCursor = z.infer<typeof projectPageCursorSchema>;

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// 游标同时固定更新时间和 id，避免只按随机 UUID 分页，也避免相同时间的记录被跳过或重复。
export function encodeProjectPageCursor(cursor: ProjectPageCursor): string {
  return encodeBase64Url(JSON.stringify(projectPageCursorSchema.parse(cursor)));
}

export function decodeProjectPageCursor(value: string): ProjectPageCursor {
  const token = projectPageCursorTokenSchema.parse(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(token));
  } catch {
    parsed = undefined;
  }
  return projectPageCursorSchema.parse(parsed);
}
