import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  decodeProjectPageCursor,
  encodeProjectPageCursor,
  projectListQuerySchema,
  projectListSchema,
} from '../src/project.js';

const cursor = {
  updatedAt: '2026-10-19T12:34:56.789Z',
  id: '00000000-0000-4000-8000-000000000001',
};

describe('项目列表游标协议', () => {
  it('往返保留毫秒及相同时间的 id 边界，客户端可安全放进查询参数', () => {
    const token = encodeProjectPageCursor(cursor);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeProjectPageCursor(token)).toEqual(cursor);
    expect(decodeProjectPageCursor(decodeURIComponent(encodeURIComponent(token)))).toEqual(cursor);
    expect(projectListQuerySchema.parse({ cursor: token })).toEqual({ cursor: token });
    expect(projectListSchema.parse({ items: [], nextCursor: token }).nextCursor).toBe(token);
  });

  it('只接受与数据库及 Date 一致的毫秒时间，不静默截断更高精度的分页边界', () => {
    for (const updatedAt of [
      '2026-10-19T12:34:56.789123Z',
      '2026-10-19T12:34:56.78Z',
      '2026-10-19T12:34:56Z',
    ]) {
      expect(() => encodeProjectPageCursor({ ...cursor, updatedAt })).toThrow(z.ZodError);
      const forged = btoa(JSON.stringify({ ...cursor, updatedAt }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
      expect(() => decodeProjectPageCursor(forged)).toThrow(z.ZodError);
    }
  });

  it('拒绝畸形、超长或非预期内容的游标，查询参数保持严格白名单', () => {
    const encode = (value: unknown) =>
      btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    for (const value of [
      '',
      ' ',
      '+/==',
      'A',
      'a'.repeat(257),
      'not-base64',
      encode({ ...cursor, id: 'not-a-uuid' }),
      encode({ ...cursor, ownerId: 'injected-owner' }),
    ]) {
      expect(() => decodeProjectPageCursor(value)).toThrow(z.ZodError);
    }
    for (const query of [{ cursor: ['a', 'b'] }, { ownerId: 'other' }, { cursor: null }]) {
      expect(projectListQuerySchema.safeParse(query).success).toBe(false);
    }
    expect(projectListQuerySchema.parse({})).toEqual({});
    expect(projectListSchema.parse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});
