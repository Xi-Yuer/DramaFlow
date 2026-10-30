import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
if (existsSync('.env')) process.loadEnvFile('.env');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--test'))
  throw new Error('只接受 --test 参数');
const url = new URL(process.env.DATABASE_URL ?? '');
if (
  process.env.NODE_ENV === 'production' ||
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  !['/dramaflow', '/dramaflow_test'].includes(url.pathname)
)
  throw new Error('重置仅允许本项目本机开发数据库，禁止生产或外部数据库');
url.pathname = args[0] === '--test' ? '/dramaflow_test' : '/dramaflow';

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

const environment = { ...process.env, DATABASE_URL: url.href };
function run(command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['--filter', '@dramaflow/database', 'exec', 'prisma', ...command], {
      stdio: ['pipe', 'inherit', 'inherit'],
      env: environment,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`数据库重置失败：${code}`)),
    );
    child.stdin.end(input);
  });
}
console.info(`重置本机数据库 ${url.pathname.slice(1)}；请先停止 API / Worker。`);
// Checkpointer 归官方 Saver 管理；Prisma 只重建 public schema，故先清除旧 checkpoint。
await run(['db', 'execute', '--stdin'], 'DROP SCHEMA IF EXISTS langgraph CASCADE;');
await run(['migrate', 'reset', '--force']);
await run(['migrate', 'deploy']);
console.info('空库已应用 Foundation baseline；账号请通过 auth:bootstrap 重新创建。');
