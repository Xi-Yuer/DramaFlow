import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

if (existsSync('.env')) process.loadEnvFile('.env');
const databaseUrl = new URL(process.env.DATABASE_URL);
if (
  !['localhost', '127.0.0.1'].includes(databaseUrl.hostname) ||
  !['/dramaflow', '/dramaflow_test'].includes(databaseUrl.pathname)
) {
  throw new Error('Web 集成测试只允许本项目本机开发数据库');
}
databaseUrl.pathname = '/dramaflow_test';
Object.assign(process.env, {
  DATABASE_URL: databaseUrl.toString(),
  DRAMAFLOW_INTEGRATION: '1',
  DRAMAFLOW_LIVE_AI: '0',
  WORKFLOW_QUEUE_PREFIX: `dramaflow-test-${randomUUID()}`,
  API_PORT: '3201',
  API_INTERNAL_URL: 'http://127.0.0.1:3201',
  API_URL: 'http://127.0.0.1:3201',
  BETTER_AUTH_URL: 'http://127.0.0.1:3200',
  WEB_ORIGIN: 'http://127.0.0.1:3200',
});
async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Web 集成测试命令失败：${code}`)),
    );
  });
}
await run([
  'exec',
  'turbo',
  'run',
  'build',
  '--filter=@dramaflow/api...',
  '--filter=@dramaflow/web',
]);
await run(['--filter', '@dramaflow/database', 'migrate:deploy']);
const { createDatabase } = await import('../packages/database/dist/index.js');
const { createAuth } = await import('../apps/api/dist/auth/auth.factory.js');
const db = createDatabase();
const users = [];
try {
  const auth = createAuth(db);
  for (const kind of ['OWNER', 'OTHER']) {
    const email = `web-${randomUUID()}@example.test`;
    const password = randomUUID();
    const result = await auth.api.createUser({
      body: { email, password, name: 'Web 集成测试', role: 'user' },
    });
    users.push(result.user.id);
    process.env[`WEB_TEST_${kind}_EMAIL`] = email;
    process.env[`WEB_TEST_${kind}_PASSWORD`] = password;
  }
  // 显式初始化路径使用缺少 Workflow 的项目；普通项目和图通过正式 HTTP 创建。
  await run(['--filter', '@dramaflow/web', 'exec', 'playwright', 'test', ...process.argv.slice(2)]);
} finally {
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
}
