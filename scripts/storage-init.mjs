import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
// 复用服务端基础设施包已锁定的官方 SDK，不增加初始化工具镜像。
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { S3Client, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');
for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
  if (!process.env[key]) throw new Error(`${key} 未配置，请先运行 pnpm env:init`);
}
const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});
try {
  try {
    await client.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET }));
  } catch (error) {
    if (error?.$metadata?.httpStatusCode !== 404) throw error;
    try {
      await client.send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET }));
    } catch (creationError) {
      if (creationError?.name !== 'BucketAlreadyOwnedByYou') throw creationError;
    }
  }
  console.info('RustFS 素材桶已就绪。');
} finally {
  client.destroy();
}
