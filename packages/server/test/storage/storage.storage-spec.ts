import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { StorageService } from '../../src/storage/storage.service.js';

describe('真实 RustFS 存储', () => {
  const bucket = `dramaflow-check-${randomUUID()}`;
  const keys: string[] = [];
  let client: S3Client;
  let storage: StorageService;
  let created = false;

  beforeAll(async () => {
    for (const key of ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      if (!process.env[key]) throw new Error(`${key} 未配置`);
    }
    vi.stubEnv('S3_BUCKET', bucket);
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
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      }
    } finally {
      storage?.onModuleDestroy();
      client?.destroy();
      vi.unstubAllEnvs();
    }
  });

  it('经平台适配层保存二进制、保留 MIME、跨客户端读取一致', async () => {
    const bytes = randomBytes(1024 * 1024);
    const key = randomUUID();
    keys.push(key);
    await storage.put(key, bytes, 'application/octet-stream');
    expect(Buffer.from(await storage.get(key))).toEqual(bytes);
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    expect(object.ContentType).toBe('application/octet-stream');
    expect(Buffer.from(await object.Body!.transformToByteArray())).toEqual(bytes);
    expect(await storage.head(key)).toEqual({
      size: bytes.byteLength,
      mimeType: 'application/octet-stream',
    });
    const url = await storage.signedGetUrl(key);
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('900');
    const response = await fetch(url);
    expect(response.ok).toBe(true);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it('不存在的对象明确报错', async () => {
    await expect(storage.get(randomUUID())).rejects.toThrow();
    await expect(storage.head(randomUUID())).rejects.toThrow();
    const key = randomUUID();
    keys.push(key);
    await storage.put(key, new Uint8Array([1]), 'application/octet-stream');
    await storage.delete(key);
    await expect(storage.head(key)).rejects.toThrow();
  });

  it('未授权读取私有对象被拒绝', async () => {
    const key = randomUUID();
    keys.push(key);
    await storage.put(key, Buffer.from('private'), 'text/plain');
    const response = await fetch(`${process.env.S3_ENDPOINT}/${bucket}/${key}`);
    expect(response.status).toBe(403);
  });

  it('缺少配置直接失败，不隐式降级', () => {
    const secret = process.env.S3_SECRET_ACCESS_KEY;
    vi.stubEnv('S3_SECRET_ACCESS_KEY', '');
    try {
      expect(() => new StorageService()).toThrow('S3_SECRET_ACCESS_KEY');
    } finally {
      vi.stubEnv('S3_SECRET_ACCESS_KEY', secret);
    }
  });
});
