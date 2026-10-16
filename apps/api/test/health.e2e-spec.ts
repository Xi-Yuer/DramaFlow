import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';

const origin = 'http://127.0.0.1:3101';
let server: ChildProcess;

beforeAll(async () => {
  server = spawn(process.execPath, ['dist/main.js'], {
    env: { ...process.env, PORT: '3101', API_PORT: '3101' },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null)
      throw new Error('API 启动失败，请检查基础设施配置');
    try {
      const response = await fetch(`${origin}/api/v1/health`);
      if (response.ok) return;
    } catch {
      // 仅在有界启动等待内允许端口尚未监听。
    }
    await delay(200);
  }
  throw new Error('API 健康检查超时');
});

afterAll(async () => {
  if (!server || server.exitCode !== null) return;
  const stopped = once(server, 'exit');
  server.kill('SIGTERM');
  await stopped;
});

it('健康接口验证真实 PostgreSQL、Redis 和对象存储', async () => {
  const response = await fetch(`${origin}/api/v1/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: 'ok',
    services: { postgres: 'up', redis: 'up', storage: 'up' },
  });
});

it('已移除的业务接口不再对外提供服务', async () => {
  for (const path of [
    '/api/v1/workspaces',
    '/api/v1/catalog',
    '/api/auth/get-session',
  ]) {
    const response = await fetch(`${origin}${path}`);
    expect(response.status).toBe(404);
  }
});
