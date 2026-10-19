import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase } from '@dramaflow/database';
import { projectSchema, projectSummarySchema } from '@dramaflow/contracts';
import { z } from 'zod';
import { createAuth } from '../src/auth/auth.factory.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  !new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname.endsWith(
    '_test',
  )
)
  throw new Error(
    '认证集成测试只能通过 pnpm test:integration 在隔离数据库运行',
  );
const db = createDatabase();
const auth = createAuth(db);
const base = 'http://127.0.0.1:3101';
const origin = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
const password = randomBytes(24).toString('hex');
const newPassword = randomBytes(24).toString('hex');
const email = `auth-${randomUUID()}@example.com`;
const adminEmail = `admin-${randomUUID()}@example.com`;
const ids: string[] = [];
let userId = '';
let server: ChildProcess;
let cookie = '';
let secondCookie = '';
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
const call = (
  path: string,
  method = 'GET',
  body?: unknown,
  session?: string,
  requestOrigin = origin,
) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(session ? { cookie: session } : {}),
      ...(body
        ? { 'Content-Type': 'application/json', Origin: requestOrigin }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const signIn = (target = email, pass = password) =>
  call('/api/auth/sign-in/email', 'POST', {
    email: target,
    password: pass,
    rememberMe: true,
  });

beforeAll(async () => {
  await db.rateLimit.deleteMany();
  for (const [target, role] of [
    [email, 'user'],
    [adminEmail, 'admin'],
  ] as const) {
    const result = await auth.api.createUser({
      body: { email: target, name: '测试创作者', password, role },
    });
    ids.push(result.user.id);
  }
  userId = ids[0]!;
  server = spawn(process.execPath, ['dist/main.js'], {
    env: { ...process.env, PORT: '3101', API_PORT: '3101' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error('测试 API 启动失败');
    try {
      if ((await fetch(`${base}/api/v1/health`)).ok) return;
    } catch {
      /* 有界等待启动 */
    }
    await delay(100);
  }
  throw new Error('测试 API 启动超时');
});

afterAll(async () => {
  try {
    if (server && server.exitCode === null) {
      const done = once(server, 'exit');
      server.kill('SIGTERM');
      await done;
    }
    await db.user.deleteMany({ where: { id: { in: ids } } });
  } finally {
    await db.$disconnect();
  }
});

it('未登录禁止访问，注册和未授权认证入口关闭', async () => {
  expect((await call('/api/v1/users/me')).status).toBe(401);
  expect(
    (
      await call('/api/auth/sign-up/email', 'POST', {
        email: 'new@example.com',
        password,
        name: 'new',
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call('/api/auth/admin/create-user', 'POST', {
        email: 'new@example.com',
        password,
        name: 'new',
      })
    ).status,
  ).toBe(404);
  const rejected = await call(
    '/api/auth/sign-in/email',
    'POST',
    { email, password },
    undefined,
    'https://untrusted.invalid',
  );
  expect(rejected.status).toBe(403);
});

it('真实密码登录、Cookie 会话和安全 DTO，不暴露凭证', async () => {
  const login = await signIn();
  expect(login.status).toBe(200);
  const header = login.headers.getSetCookie().join(' ');
  expect(header).toContain('HttpOnly');
  expect(header).toContain('SameSite=Lax');
  cookie = cookies(login);
  const me = await call('/api/v1/users/me', 'GET', undefined, cookie);
  expect(me.status).toBe(200);
  const body = await me.json();
  expect(body.email).toBe(email);
  expect(body.role).toBe('user');
  expect(JSON.stringify(body)).not.toContain('token');
  expect(JSON.stringify(body)).not.toContain('password');
  const account = await db.account.findFirstOrThrow({ where: { userId } });
  expect(account.password).not.toBe(password);
  expect(account.password!.length).toBeGreaterThan(30);
  secondCookie = cookies(await signIn());
  expect(secondCookie).not.toBe(cookie);
});

it('真实项目 API 保留基础字段、所有者隔离和版本并发校验，拒绝旧业务协议', async () => {
  expect((await call('/api/v1/projects')).status).toBe(401);
  const createdResponse = await call(
    '/api/v1/projects',
    'POST',
    { name: ' 第一集 ' },
    cookie,
  );
  expect(createdResponse.status).toBe(201);
  const created = projectSchema.parse(await createdResponse.json());
  expect(created.name).toBe('第一集');
  expect(created.revision).toBe(1);
  expect(created.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  expect(created).not.toHaveProperty('ownerId');
  expect(created).not.toHaveProperty('definition');
  expect(created).not.toHaveProperty('nodeCount');
  const path = `/api/v1/projects/${created.id}`;
  const ownProject = await call(path, 'GET', undefined, secondCookie);
  expect(ownProject.status).toBe(200);
  expect(projectSchema.parse(await ownProject.json())).toEqual(created);

  const adminLogin = await signIn(adminEmail);
  expect(adminLogin.status).toBe(200);
  const adminCookie = cookies(adminLogin);
  const adminProjectResponse = await call(
    '/api/v1/projects',
    'POST',
    { name: '管理员的项目' },
    adminCookie,
  );
  expect(adminProjectResponse.status).toBe(201);
  const adminProject = projectSchema.parse(await adminProjectResponse.json());
  expect((await call(path, 'GET', undefined, adminCookie)).status).toBe(404);
  expect(
    (
      await call(
        `/api/v1/projects/${adminProject.id}`,
        'GET',
        undefined,
        cookie,
      )
    ).status,
  ).toBe(404);
  const listSchema = z
    .object({
      items: z.array(projectSummarySchema),
      nextCursor: z.string().uuid().nullable(),
    })
    .strict();
  for (const [session, ownId, otherId] of [
    [cookie, created.id, adminProject.id],
    [adminCookie, adminProject.id, created.id],
  ]) {
    const response = await call('/api/v1/projects', 'GET', undefined, session);
    expect(response.status).toBe(200);
    const list = listSchema.parse(await response.json());
    expect(list.items.map((item) => item.id)).toContain(ownId);
    expect(list.items.map((item) => item.id)).not.toContain(otherId);
  }

  const update = {
    revision: created.revision,
    name: '第一集修改版',
    viewport: { x: 120, y: -80, zoom: 1.5 },
  };
  const saved = await call(path, 'PUT', update, cookie);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ revision: 2 });
  const loaded = await call(path, 'GET', undefined, cookie);
  expect(loaded.status).toBe(200);
  expect(projectSchema.parse(await loaded.json())).toMatchObject({
    name: update.name,
    viewport: update.viewport,
    revision: 2,
  });
  const stale = await call(path, 'PUT', update, secondCookie);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(
    (await call(path, 'PUT', { ...update, revision: 2 }, adminCookie)).status,
  ).toBe(404);

  for (const extra of [
    { definition: { schemaVersion: 1, nodes: [], edges: [], bindings: [] } },
    { nodeCount: 0 },
  ]) {
    expect(
      (
        await call(
          '/api/v1/projects',
          'POST',
          { name: '旧协议', ...extra },
          cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (await call(path, 'PUT', { ...update, revision: 2, ...extra }, cookie))
        .status,
    ).toBe(400);
  }
  expect((await call('/api/v1/plugins', 'GET', undefined, cookie)).status).toBe(
    404,
  );
});

it('资料可编辑，角色不能自助提升，跨来源写入被拒绝', async () => {
  const data = {
    name: '阿月',
    bio: '水墨漫剧创作者',
    timeZone: 'Asia/Shanghai',
  };
  const response = await call('/api/v1/users/me', 'PATCH', data, cookie);
  expect(response.status).toBe(200);
  expect((await response.json()).name).toBe('阿月');
  expect(
    (
      await call(
        '/api/v1/users/me',
        'PATCH',
        { ...data, role: 'admin' },
        cookie,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        '/api/v1/users/me',
        'PATCH',
        data,
        cookie,
        'https://untrusted.invalid',
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call(
        '/api/v1/users/me',
        'PATCH',
        { ...data, timeZone: 'invalid-zone' },
        cookie,
      )
    ).status,
  ).toBe(400);
  expect(
    (await db.user.findUniqueOrThrow({ where: { id: userId } })).role,
  ).toBe('user');
});

it('普通用户不能访问平台账号目录，管理员可以', async () => {
  expect((await call('/api/v1/users', 'GET', undefined, cookie)).status).toBe(
    403,
  );
  const adminCookie = cookies(await signIn(adminEmail));
  const directory = await call('/api/v1/users', 'GET', undefined, adminCookie);
  expect(directory.status).toBe(200);
  expect(JSON.stringify(await directory.json())).not.toContain('password');
});

it('设备列表不返回 token，撤销其他设备立即生效', async () => {
  const response = await call(
    '/api/v1/users/me/sessions',
    'GET',
    undefined,
    cookie,
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.items).toHaveLength(2);
  expect(JSON.stringify(body)).not.toContain('token');
  expect(
    body.items.filter((item: { current: boolean }) => item.current),
  ).toHaveLength(1);
  expect(
    (await call('/api/v1/users/me/revoke-other-sessions', 'POST', {}, cookie))
      .status,
  ).toBe(201);
  expect(
    (await call('/api/v1/users/me', 'GET', undefined, secondCookie)).status,
  ).toBe(401);
  expect(
    (await call('/api/v1/users/me', 'GET', undefined, cookie)).status,
  ).toBe(200);
});

it('账号停用阻止旧会话与新登录，停用用户不能修改密码', async () => {
  await db.user.update({ where: { id: userId }, data: { banned: true } });
  try {
    expect(
      (await call('/api/v1/users/me', 'GET', undefined, cookie)).status,
    ).toBe(403);
    expect((await signIn()).status).toBe(403);
    expect(
      (
        await call(
          '/api/auth/change-password',
          'POST',
          { currentPassword: password, newPassword },
          cookie,
        )
      ).status,
    ).toBe(403);
  } finally {
    await db.user.update({ where: { id: userId }, data: { banned: false } });
  }
});

it('修改密码校验旧密码并撤销其他会话，退出后访问立即失效', async () => {
  secondCookie = cookies(await signIn());
  const wrong = await call(
    '/api/auth/change-password',
    'POST',
    {
      currentPassword: 'wrong-password-123',
      newPassword,
      revokeOtherSessions: true,
    },
    cookie,
  );
  expect(wrong.status).toBe(400);
  const change = await call(
    '/api/auth/change-password',
    'POST',
    { currentPassword: password, newPassword, revokeOtherSessions: false },
    cookie,
  );
  expect(change.status).toBe(200);
  cookie = cookies(change) || cookie;
  expect(
    (await call('/api/v1/users/me', 'GET', undefined, secondCookie)).status,
  ).toBe(401);
  expect((await signIn(email, password)).status).toBe(401);
  const fresh = await signIn(email, newPassword);
  expect(fresh.status).toBe(200);
  cookie = cookies(fresh);
  expect((await call('/api/auth/sign-out', 'POST', {}, cookie)).status).toBe(
    200,
  );
  expect(
    (await call('/api/v1/users/me', 'GET', undefined, cookie)).status,
  ).toBe(401);
});

it('服务端拒绝过期会话，并对连续登录尝试限流', async () => {
  await db.rateLimit.deleteMany();
  const fresh = await signIn(email, newPassword);
  expect(fresh.status).toBe(200);
  const expiredCookie = cookies(fresh);
  await db.session.updateMany({
    where: { userId },
    data: { expiresAt: new Date(0) },
  });
  expect(
    (await call('/api/v1/users/me', 'GET', undefined, expiredCookie)).status,
  ).toBe(401);
  await db.rateLimit.deleteMany();
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const response = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'x-forwarded-for': `198.51.100.${i + 1}`,
        'x-real-ip': `198.51.100.${i + 1}`,
      },
      body: JSON.stringify({ email, password: 'invalid-password-123' }),
    });
    if (response.status === 429) {
      limited = true;
      break;
    }
  }
  expect(limited).toBe(true);
});
