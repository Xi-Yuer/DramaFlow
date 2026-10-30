import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
if (existsSync('.env')) process.loadEnvFile('.env');
const url = new URL(process.env.DATABASE_URL ?? '');
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  !['/dramaflow', '/dramaflow_test'].includes(url.pathname)
)
  throw new Error('迁移验证仅允许本项目本机数据库');
url.pathname = '/dramaflow_test';

// 仅初始化经过白名单校验的本项目本机目标，不修改 migration ledger。
const require = createRequire(new URL('../packages/database/package.json', import.meta.url));
const { Client } = require('pg');
const maintenance = new URL(url);
maintenance.pathname = '/postgres';
const admin = new Client({ connectionString: maintenance.href });
await admin.connect();
try {
  const name = url.pathname.slice(1);
  const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
  if (!existing.rowCount) await admin.query(`CREATE DATABASE "${name}"`);
} finally {
  await admin.end();
}

const child = spawn('pnpm', ['--filter', '@dramaflow/database', 'test'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url.href, DRAMAFLOW_INTEGRATION: '1' },
});
child.once('error', () => {
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
