import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

if (existsSync('.env')) process.loadEnvFile('.env');
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`基础设施检查失败：${code}`)),
    );
  });
}
await run(['build']);
const { createDatabase } = await import('../packages/database/dist/index.js');
const db = createDatabase();
try {
  const existing =
    await db.$queryRaw`SELECT datname FROM pg_database WHERE datname = 'dramaflow_test'`;
  if (!existing.length) await db.$executeRawUnsafe('CREATE DATABASE dramaflow_test');
} finally {
  await db.$disconnect();
}
const url = new URL(process.env.DATABASE_URL);
url.pathname = '/dramaflow_test';
process.env.DATABASE_URL = url.toString();
await run(['--filter', '@dramaflow/database', 'migrate:deploy']);
