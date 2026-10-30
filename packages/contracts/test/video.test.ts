import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createVideoSchema,
  saveVideoSchema,
  videoSchema,
  videoStatusSchema,
  videoListQuerySchema,
  decodeVideoPageCursor,
  encodeVideoPageCursor,
} from '../src/video.js';

describe('Video 基础身份协议', () => {
  it('创建只接受名称并去除首尾空白，不要求运行或文件', () => {
    expect(createVideoSchema.parse({ name: ' 雨夜来信 ' })).toEqual({ name: '雨夜来信' });
    for (const name of ['', '  ', 'a'.repeat(81)])
      expect(createVideoSchema.safeParse({ name }).success).toBe(false);
  });
  it.each([
    'projectId',
    'ownerId',
    'status',
    'script',
    'storyboard',
    'shots',
    'workflowId',
    'finalVideoUrl',
    'prompt',
  ])('创建拒绝未授权字段 %s', (key) =>
    expect(createVideoSchema.safeParse({ name: '作品', [key]: 'injected' }).success).toBe(false),
  );
  it('生命周期只表达粗粒度状态，保存必须携带修订号', () => {
    for (const status of ['draft', 'active', 'completed'])
      expect(videoStatusSchema.safeParse(status).success).toBe(true);
    for (const status of ['scripting', 'generating', 'rendering', 'archived'])
      expect(videoStatusSchema.safeParse(status).success).toBe(false);
    expect(saveVideoSchema.parse({ revision: 1, name: ' 作品 ', status: 'active' })).toEqual({
      revision: 1,
      name: '作品',
      status: 'active',
    });
    for (const extra of [{ revision: 0 }, { revision: undefined }, { projectId: 'other' }])
      expect(
        saveVideoSchema.safeParse({ revision: 1, name: '作品', status: 'draft', ...extra }).success,
      ).toBe(false);
  });
  it('作品身份可以先于任何生成存在', () => {
    const video = {
      id: '00000000-0000-4000-8000-000000000001',
      projectId: '00000000-0000-4000-8000-000000000002',
      name: '作品',
      status: 'draft',
      revision: 1,
      createdAt: '2026-10-30T00:00:00.000Z',
      updatedAt: '2026-10-30T00:00:00.000Z',
    };
    expect(videoSchema.parse(video)).toEqual(video);
    expect(
      videoSchema.safeParse({ ...video, finalVideoUrl: 'https://example.test/video.mp4' }).success,
    ).toBe(false);
  });
  it('分页游标保留创建时间与 ID，拒绝不精确时间及非法查询', () => {
    const cursor = {
      id: '00000000-0000-4000-8000-000000000001',
      createdAt: '2026-10-30T00:00:00.123Z',
    };
    const token = encodeVideoPageCursor(cursor);
    expect(decodeVideoPageCursor(token)).toEqual(cursor);
    for (const value of ['', 'a', 'not-base64', '+/==', 'a'.repeat(257)])
      expect(() => decodeVideoPageCursor(value)).toThrow(z.ZodError);
    expect(() =>
      encodeVideoPageCursor({ ...cursor, createdAt: '2026-10-30T00:00:00.123456Z' }),
    ).toThrow(z.ZodError);
    expect(videoListQuerySchema.safeParse({ projectId: cursor.id }).success).toBe(false);
  });
});
