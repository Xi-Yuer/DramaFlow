import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

if (existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.DATABASE_URL) throw new Error('请先 pnpm env:init 和 pnpm infra:up');

function run(args, env = process.env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('pnpm', args, { stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolveResult() : reject(new Error(`集成任务退出：${code}`)),
    );
  });
}

await run(['build']);
const { createDatabase } = await import('../packages/database/dist/index.js');
const db = createDatabase();
try {
  const databases =
    await db.$queryRaw`SELECT datname FROM pg_database WHERE datname = 'dramaflow_test'`;
  if (databases.length === 0) await db.$executeRawUnsafe('CREATE DATABASE dramaflow_test');
} finally {
  await db.$disconnect();
}

const databaseUrl = new URL(process.env.DATABASE_URL);
databaseUrl.pathname = '/dramaflow_test';
const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
redisUrl.pathname = '/1';
const testEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl.toString(),
  REDIS_URL: redisUrl.toString(),
  DRAMAFLOW_INTEGRATION: '1',
  S3_BUCKET: 'dramaflow-test',
  STORAGE_DRIVER: 's3',
};
await run(['storage:init'], testEnv);
await run(['--filter', '@dramaflow/database', 'migrate:deploy'], testEnv);
await run(['--filter', '@dramaflow/database', 'bootstrap-admin'], testEnv);
await run(['--filter', '@dramaflow/api', 'test:e2e'], testEnv);
