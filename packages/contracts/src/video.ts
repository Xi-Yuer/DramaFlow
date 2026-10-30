import { z } from 'zod';

export const videoStatusSchema = z.enum(['draft', 'active', 'completed']);
export const createVideoSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export const saveVideoSchema = z
  .object({
    revision: z.number().int().positive(),
    name: createVideoSchema.shape.name,
    status: videoStatusSchema,
  })
  .strict();
export const videoSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    name: createVideoSchema.shape.name,
    status: videoStatusSchema,
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const saveVideoResultSchema = z
  .object({ revision: z.number().int().positive(), updatedAt: z.iso.datetime() })
  .strict();
const videoPageCursorTokenSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
const videoPageCursorSchema = z
  .object({ createdAt: z.iso.datetime({ precision: 3 }), id: z.uuid() })
  .strict();
export const videoListQuerySchema = z
  .object({ cursor: videoPageCursorTokenSchema.optional() })
  .strict();
export const videoListSchema = z
  .object({ items: z.array(videoSchema), nextCursor: videoPageCursorTokenSchema.nullable() })
  .strict();

export type Video = z.infer<typeof videoSchema>;
export type VideoStatus = z.infer<typeof videoStatusSchema>;
export type SaveVideo = z.infer<typeof saveVideoSchema>;
export type VideoPageCursor = z.infer<typeof videoPageCursorSchema>;

// 时间和 UUID 均为 ASCII；按创建时间分页，改名和状态变更不移动分页边界。
export function encodeVideoPageCursor(cursor: VideoPageCursor): string {
  return btoa(JSON.stringify(videoPageCursorSchema.parse(cursor)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function decodeVideoPageCursor(token: string): VideoPageCursor {
  const value = videoPageCursorTokenSchema.parse(token).replaceAll('-', '+').replaceAll('_', '/');
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(value + '='.repeat((4 - (value.length % 4)) % 4)));
  } catch {
    parsed = undefined;
  }
  return videoPageCursorSchema.parse(parsed);
}
