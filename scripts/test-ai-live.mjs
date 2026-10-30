import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

// 只有显式执行此命令才启用真实模型请求；模型、地址与凭证环境变量名均由操作者提供。
async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  for (const name of [
    'DRAMAFLOW_LIVE_AI_BASE_URL',
    'DRAMAFLOW_LIVE_AI_MODEL',
    'DRAMAFLOW_LIVE_AI_CREDENTIAL_ENV',
  ])
    if (!process.env[name]) throw new Error('模型测试参数未配置');
  const credentialEnv = process.env.DRAMAFLOW_LIVE_AI_CREDENTIAL_ENV;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialEnv) || !process.env[credentialEnv])
    throw new Error('模型测试凭证未配置');
  for (const path of ['apps/api/dist/app.module.js', 'apps/worker/dist/app.module.js'])
    if (!existsSync(path)) throw new Error('请先构建应用');
  const url = new URL(process.env.DATABASE_URL);
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !['/dramaflow', '/dramaflow_test'].includes(url.pathname)
  )
    throw new Error('仅允许本项目本机测试数据库');
  const { createDatabase } = await import('../packages/database/dist/index.js');
  const database = createDatabase();
  try {
    const rows =
      await database.$queryRaw`SELECT datname FROM pg_database WHERE datname = 'dramaflow_test'`;
    if (rows.length === 0) await database.$executeRawUnsafe('CREATE DATABASE dramaflow_test');
  } finally {
    await database.$disconnect();
  }
  url.pathname = '/dramaflow_test';
  const environment = {
    ...process.env,
    DATABASE_URL: url.toString(),
    DRAMAFLOW_INTEGRATION: '1',
    DRAMAFLOW_LIVE_AI: '1',
    WORKFLOW_QUEUE_PREFIX: `dramaflow-test-live-${randomUUID()}`,
  };
  async function run(args) {
    await new Promise((resolve, reject) => {
      const child = spawn('pnpm', args, { stdio: 'inherit', env: environment });
      child.once('error', () => reject(new Error('测试进程不可用')));
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('测试未完成'))));
    });
  }
  await run(['--filter', '@dramaflow/database', 'migrate:deploy']);
  await run([
    '--filter',
    '@dramaflow/api',
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.config.e2e.ts',
    'test/ai-text-live.e2e-spec.ts',
  ]);
}

try {
  await main();
} catch {
  console.error('真实模型测试未完成，未自动重试；请检查构建、显式模型配置与本机测试基础设施。');
  process.exitCode = 1;
}
