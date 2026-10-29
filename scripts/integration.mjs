import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

if (existsSync('.env')) process.loadEnvFile('.env');
const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
const storageUrl = new URL(process.env.S3_ENDPOINT ?? '');
for (const url of [databaseUrl, redisUrl, storageUrl]) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('集成测试仅允许本机 PostgreSQL / Redis / 对象存储');
}
if (!['/dramaflow', '/dramaflow_test'].includes(databaseUrl.pathname))
  throw new Error('集成测试仅允许本项目开发连接，执行目标固定为 dramaflow_test');
const runId = randomUUID();
const bucket = `dramaflow-test-${runId}`;
const environment = {
  ...process.env,
  DRAMAFLOW_INTEGRATION: '1',
  DRAMAFLOW_LIVE_AI: '0',
  WORKFLOW_QUEUE_PREFIX: `dramaflow-test-${runId}`,
  S3_BUCKET: bucket,
};
async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, { stdio: 'inherit', env: environment });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`集成测试命令失败：${code}`)),
    );
  });
}
await run(['build']);
const { createDatabase } = await import('../packages/database/dist/index.js');
const database = createDatabase(databaseUrl.href);
try {
  const existing =
    await database.$queryRaw`SELECT datname FROM pg_database WHERE datname = 'dramaflow_test'`;
  if (!existing.length) await database.$executeRawUnsafe('CREATE DATABASE dramaflow_test');
} finally {
  await database.$disconnect();
}
databaseUrl.pathname = '/dramaflow_test';
environment.DATABASE_URL = databaseUrl.href;
Object.assign(process.env, environment);
await run(['--filter', '@dramaflow/database', 'migrate:deploy']);
// 官方 Saver 初始化既有隔离测试库；不读写开发库 checkpoint。
const { WorkflowCheckpointerService } = await import('../packages/server/dist/index.js');
const checkpoints = new WorkflowCheckpointerService();
try {
  await checkpoints.onModuleInit();
} finally {
  await checkpoints.onModuleDestroy();
}
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const {
  S3Client,
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} = require('@aws-sdk/client-s3');
const storage = new S3Client({
  endpoint: storageUrl.href,
  region: environment.S3_REGION ?? 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: environment.S3_ACCESS_KEY_ID,
    secretAccessKey: environment.S3_SECRET_ACCESS_KEY,
  },
});
let created = false;
try {
  await storage.send(new CreateBucketCommand({ Bucket: bucket }));
  created = true;
  await run([
    '--filter',
    '@dramaflow/api',
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.config.e2e.ts',
    '--exclude',
    '**/ai-text-live.e2e-spec.ts',
  ]);
  await run(['--filter', '@dramaflow/server', 'exec', 'vitest', 'run']);
  // database 包本身不依赖 vitest，正式入口是 workspace vitest。
  await run(['--filter', '@dramaflow/database', 'test']);
  await run([
    '--filter',
    '@dramaflow/server',
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.config.storage.ts',
  ]);
} finally {
  try {
    if (created) {
      // 只清本轮随机测试桶；绝不清空配置中的开发素材桶。
      for (;;) {
        const page = await storage.send(new ListObjectsV2Command({ Bucket: bucket }));
        if (!page.Contents?.length) break;
        const result = await storage.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: page.Contents.map(({ Key }) => ({ Key })) },
          }),
        );
        if (result.Errors?.length) throw new Error('测试对象清理失败');
      }
      await storage.send(new DeleteBucketCommand({ Bucket: bucket }));
    }
  } finally {
    storage.destroy();
  }
}
