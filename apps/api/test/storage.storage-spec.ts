import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { StorageService } from '../src/assets/storage.service.js';

describe('真实 RustFS 存储', () => {
  const bucket = `dramaflow-check-${randomUUID()}`;
  const keys: string[] = [];
  let client: S3Client;
  let storage: StorageService;
  let directory: string;
  let created = false;

  beforeAll(async () => {
    for (const key of [
      'S3_ENDPOINT',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
    ]) {
      if (!process.env[key]) throw new Error(`${key} 未配置`);
    }
    directory = await mkdtemp(join(tmpdir(), 'dramaflow-storage-'));
    vi.stubEnv('STORAGE_PATH', directory);
    vi.stubEnv('S3_BUCKET', bucket);
    vi.stubEnv('STORAGE_DRIVER', 's3');
    client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    created = true;
    storage = new StorageService();
  });

  afterAll(async () => {
    try {
      if (created) {
        for (const key of keys)
          await client.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: key }),
          );
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      }
    } finally {
      storage?.onModuleDestroy();
      client?.destroy();
      if (directory) await rm(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it('经平台适配层保存二进制、保留 MIME、跨客户端读取一致', async () => {
    const bytes = randomBytes(1024 * 1024);
    const stored = await storage.put(bytes, 'application/octet-stream');
    keys.push(stored.storageKey);
    expect(stored.storageType).toBe('s3');
    expect(
      Buffer.from(await storage.get(stored.storageType, stored.storageKey)),
    ).toEqual(bytes);
    const object = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: stored.storageKey }),
    );
    expect(object.ContentType).toBe('application/octet-stream');
    expect(Buffer.from(await object.Body!.transformToByteArray())).toEqual(
      bytes,
    );
  });

  it('切换为 S3 后仍可读取旧的本地资产', async () => {
    const key = randomUUID();
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, key), 'legacy-asset');
    expect(Buffer.from(await storage.get('local', key)).toString()).toBe(
      'legacy-asset',
    );
    await expect(storage.get('local', '../.env')).rejects.toThrow(
      '素材存储标识无效',
    );
  });

  it('未授权读取私有对象被拒绝', async () => {
    const stored = await storage.put(Buffer.from('private'), 'text/plain');
    keys.push(stored.storageKey);
    const response = await fetch(
      `${process.env.S3_ENDPOINT}/${bucket}/${stored.storageKey}`,
    );
    expect(response.status).toBe(403);
  });

  it('缺少配置直接失败，不回退本地写入', () => {
    const secret = process.env.S3_SECRET_ACCESS_KEY;
    vi.stubEnv('S3_SECRET_ACCESS_KEY', '');
    try {
      expect(() => new StorageService()).toThrow('S3_SECRET_ACCESS_KEY');
    } finally {
      vi.stubEnv('S3_SECRET_ACCESS_KEY', secret);
    }
  });
});
