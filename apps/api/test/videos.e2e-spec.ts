import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Module, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DatabaseModule, DatabaseService } from '@dramaflow/server';
import { videoSchema, videoListSchema, saveVideoResultSchema } from '@dramaflow/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiExceptionFilter } from '../src/http/exception.filter.js';
import type { AuthService } from '../src/auth/auth.service.js';
import { authBaseUrl } from '../src/auth/trusted-origin.js';

const enabled = process.env.DRAMAFLOW_INTEGRATION === '1';
const origin = new URL(authBaseUrl()).origin;
let app: NestExpressApplication;
let db: DatabaseService['client'];
let base: string;
const users: string[] = [];
const cookies: string[] = [];
let projects: string[];

async function api(
  method: string,
  projectId: string,
  videoId = '',
  body?: unknown,
  actor = 0,
  requestOrigin = origin,
) {
  return fetch(`${base}/api/v1/projects/${projectId}/videos${videoId ? `/${videoId}` : ''}`, {
    method,
    headers: {
      Cookie: cookies[actor] ?? '',
      Origin: requestOrigin,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function create(projectId = projects[0]!, name = '雨夜来信') {
  const response = await api('POST', projectId, '', { name });
  expect(response.status).toBe(201);
  return videoSchema.parse(await response.json());
}

describe.skipIf(!enabled)('Video 真实 Auth / HTTP / Prisma 项目隔离', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/dramaflow_test')
      throw Error('仅允许本项目本机隔离测试库');
    const constructor = z.custom<Type<unknown>>((value) => typeof value === 'function');
    const videoModule: unknown = await import(
      new URL('../dist/videos/videos.module.js', import.meta.url).href
    );
    const authModule: unknown = await import(
      new URL('../dist/auth/auth.module.js', import.meta.url).href
    );
    const authService: unknown = await import(
      new URL('../dist/auth/auth.service.js', import.meta.url).href
    );
    const { VideosModule } = z.object({ VideosModule: constructor }).parse(videoModule);
    const { AuthModule } = z.object({ AuthModule: constructor }).parse(authModule);
    const { AuthService: AuthToken } = z.object({ AuthService: constructor }).parse(authService);
    // 使用正式模块与全局 AuthGuard；本领域没有队列、Worker 或对象存储依赖。
    class VideoApiTestModule {}
    Module({ imports: [DatabaseModule, AuthModule, VideosModule] })(VideoApiTestModule);
    app = await NestFactory.create<NestExpressApplication>(VideoApiTestModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    db = app.get(DatabaseService).client;
    const auth = app.get<AuthService>(AuthToken).auth;
    const password = randomBytes(24).toString('hex');
    for (const label of ['A', 'B']) {
      const email = `video-${randomUUID()}@example.test`;
      const { user } = await auth.api.createUser({
        body: { email, password, name: `Video 测试 ${label}`, role: 'user' },
      });
      users.push(user.id);
      const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
      expect(response.status).toBe(200);
      cookies.push(
        response.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; '),
      );
    }
  }, 60000);
  beforeEach(async () => {
    projects = [];
    for (const ownerId of [users[0]!, users[0]!, users[1]!]) {
      const project = await db.project.create({
        data: { ownerId, name: '视频隔离项目', viewport: { x: 0, y: 0, zoom: 1 } },
      });
      projects.push(project.id);
    }
  });
  afterAll(async () => {
    try {
      if (users.length) await db.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await app?.close();
    }
  });

  it('无 Workflow / Run / 文件时创建、列表、读取、改名和手动状态更新', async () => {
    const projectId = projects[0]!;
    const empty = videoListSchema.parse(await (await api('GET', projectId)).json());
    expect(empty).toEqual({ items: [], nextCursor: null });
    const video = await create(projectId, ' 雨夜来信 ');
    expect(video).toMatchObject({ projectId, name: '雨夜来信', status: 'draft', revision: 1 });
    expect(videoSchema.parse(await (await api('GET', projectId, video.id)).json())).toEqual(video);
    expect(videoListSchema.parse(await (await api('GET', projectId)).json()).items).toEqual([
      video,
    ]);
    const saved = await api('PUT', projectId, video.id, {
      name: '雨夜来信 · 完整版',
      status: 'completed',
      revision: 1,
    });
    expect(saved.status).toBe(200);
    const receipt = saveVideoResultSchema.parse(await saved.json());
    expect(receipt.revision).toBe(2);
    const updated = videoSchema.parse(await (await api('GET', projectId, video.id)).json());
    expect(updated).toMatchObject({
      id: video.id,
      projectId,
      name: '雨夜来信 · 完整版',
      status: 'completed',
      revision: 2,
      updatedAt: receipt.updatedAt,
    });
    expect(updated.createdAt).toBe(video.createdAt);
    expect(await db.workflow.count({ where: { projectId } })).toBe(0);
    expect(await db.workflowRun.count({ where: { projectId } })).toBe(0);
  });
  it('同一所有者的不同 Project 也不能通过 Video ID 读、改或删除', async () => {
    const video = await create();
    await create(projects[1]!, '另一个项目作品');
    for (const method of ['GET', 'PUT', 'DELETE']) {
      expect(
        (
          await api(
            method,
            projects[1]!,
            video.id,
            method === 'PUT' ? { name: '越界', status: 'active', revision: 1 } : undefined,
          )
        ).status,
      ).toBe(404);
    }
    expect(
      videoListSchema
        .parse(await (await api('GET', projects[0]!)).json())
        .items.map((item) => item.id),
    ).toEqual([video.id]);
    expect((await db.video.findUniqueOrThrow({ where: { id: video.id } })).name).toBe(video.name);
  });
  it('其他账号不能读取项目列表、创建、读取、改名或删除作品', async () => {
    const video = await create();
    for (const [method, id, body] of [
      ['GET', '', undefined],
      ['POST', '', { name: '越权作品' }],
      ['GET', video.id, undefined],
      ['PUT', video.id, { name: '越权修改', status: 'active', revision: 1 }],
      ['DELETE', video.id, undefined],
    ] as const)
      expect((await api(method, projects[0]!, id, body, 1)).status).toBe(404);
    expect(await db.video.count({ where: { projectId: projects[0]! } })).toBe(1);
  });
  it('默认认证与写入来源检查继续有效', async () => {
    expect((await api('GET', projects[0]!, '', undefined, 10)).status).toBe(401);
    expect(
      (await api('POST', projects[0]!, '', { name: '作品' }, 0, 'https://untrusted.example'))
        .status,
    ).toBe(403);
  });
  it('非法或不存在的 Project / Video 与越界字段均明确失败', async () => {
    const missing = randomUUID();
    expect((await api('GET', 'invalid')).status).toBe(400);
    expect((await api('POST', 'invalid', '', { name: '作品' })).status).toBe(400);
    expect((await api('GET', missing)).status).toBe(404);
    expect((await api('POST', missing, '', { name: '作品' })).status).toBe(404);
    for (const method of ['GET', 'PUT', 'DELETE'])
      for (const [projectId, id, expected] of [
        [projects[0]!, 'invalid', 400],
        ['invalid', missing, 400],
        [projects[0]!, missing, 404],
        [missing, missing, 404],
      ] as const)
        expect(
          (
            await api(
              method,
              projectId,
              id,
              method === 'PUT' ? { name: '作品', status: 'draft', revision: 1 } : undefined,
            )
          ).status,
        ).toBe(expected);
    for (const body of [
      { name: ' ' },
      { name: 'x'.repeat(81) },
      { name: '作品', workflowId: missing },
      { name: '作品', projectId: projects[1] },
      { name: '作品', status: 'active' },
    ])
      expect((await api('POST', projects[0]!, '', body)).status).toBe(400);
    const video = await create();
    expect(
      (
        await api('PUT', projects[0]!, video.id, {
          name: '作品',
          status: 'generating',
          revision: 1,
        })
      ).status,
    ).toBe(400);
  });
  it('并发保存以 revision 拒绝旧请求，不覆盖已提交信息', async () => {
    const video = await create();
    const responses = await Promise.all(
      ['第一次', '第二次'].map((name) =>
        api('PUT', projects[0]!, video.id, { name, status: 'active', revision: 1 }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const latest = videoSchema.parse(await (await api('GET', projects[0]!, video.id)).json());
    expect(latest.revision).toBe(2);
    expect(['第一次', '第二次']).toContain(latest.name);
  });
  it('列表在相同创建时间按 ID 稳定分页，改名不改变分页位置', async () => {
    const createdAt = new Date('2026-10-30T00:00:00.123Z');
    await db.video.createMany({
      data: Array.from({ length: 31 }, (_, index) => ({
        id: randomUUID(),
        projectId: projects[0]!,
        name: `作品 ${index}`,
        createdAt,
      })),
    });
    const first = videoListSchema.parse(await (await api('GET', projects[0]!)).json());
    expect(first.items).toHaveLength(30);
    expect(first.nextCursor).not.toBeNull();
    await api('PUT', projects[0]!, first.items[0]!.id, {
      name: '改名',
      status: 'active',
      revision: 1,
    });
    const nextResponse = await fetch(
      `${base}/api/v1/projects/${projects[0]}/videos?cursor=${first.nextCursor}`,
      { headers: { Cookie: cookies[0]! } },
    );
    const next = videoListSchema.parse(await nextResponse.json());
    expect(next.items).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...first.items, ...next.items].map((item) => item.id)).size).toBe(31);
    expect(
      (
        await fetch(`${base}/api/v1/projects/${projects[0]}/videos?cursor=invalid`, {
          headers: { Cookie: cookies[0]! },
        })
      ).status,
    ).toBe(400);
  });
  it('删除作品保留 Project，删除 Project 级联清除其全部 Video', async () => {
    const first = await create();
    const second = await create(projects[0]!, '第二个作品');
    const response = await api('DELETE', projects[0]!, first.id);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect((await api('GET', projects[0]!, first.id)).status).toBe(404);
    expect(await db.project.findUnique({ where: { id: projects[0]! } })).not.toBeNull();
    await db.project.delete({ where: { id: projects[0]! } });
    expect(await db.video.findUnique({ where: { id: second.id } })).toBeNull();
  });
});
