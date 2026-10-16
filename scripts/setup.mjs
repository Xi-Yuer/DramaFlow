import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const randomKey = () => randomBytes(24).toString('hex');
const storage = {
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'dramaflow',
  S3_ACCESS_KEY_ID: randomBytes(16).toString('hex'),
  S3_SECRET_ACCESS_KEY: randomKey(),
};
if (existsSync('.env')) {
  // 只补齐新增变量，已有密码、端点和驱动由用户显式维护。
  const existing = readFileSync('.env', 'utf8');
  const additions = Object.entries(storage).filter(
    ([key]) => !new RegExp(`^${key}=`, 'm').test(existing),
  );
  if (additions.length) {
    writeFileSync(
      '.env',
      `${existing.trimEnd()}\n${additions.map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
    );
  }
  chmodSync('.env', 0o600);
  console.info('.env 已保留，缺少的 RustFS 配置已补齐。');
} else {
  const password = randomKey();
  const config = {
    POSTGRES_PASSWORD: password,
    POSTGRES_PORT: '5432',
    REDIS_PORT: '6379',
    DATABASE_URL: `postgresql://dramaflow:${password}@localhost:5432/dramaflow`,
    REDIS_URL: 'redis://localhost:6379',
    WEB_ORIGIN: 'http://localhost:3000',
    CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    API_URL: 'http://localhost:3001',
    PORT: '3001',
    ...storage,
  };
  writeFileSync(
    '.env',
    `# 本地配置，禁止提交。由 pnpm env:init 生成。\n${Object.entries(config)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  console.info('已生成 .env（权限 0600），包含 PostgreSQL 及 RustFS 随机凭证。');
}
