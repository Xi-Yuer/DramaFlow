import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { z } from 'zod';

@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly mode: 's3' | 'local';
  private readonly directory = resolve(
    process.env.STORAGE_PATH ?? '.local/assets',
  );
  private readonly bucket?: string;
  private readonly s3?: S3Client;

  constructor() {
    this.mode = z
      .enum(['s3', 'local'])
      .parse(process.env.STORAGE_DRIVER ?? 's3');
    if (this.mode === 's3') {
      const config = z
        .object({
          S3_ENDPOINT: z.url(),
          S3_BUCKET: z.string().min(3),
          S3_ACCESS_KEY_ID: z.string().min(1),
          S3_SECRET_ACCESS_KEY: z.string().min(1),
          S3_REGION: z.string().min(1).default('us-east-1'),
        })
        .safeParse(process.env);
      if (!config.success) {
        // 不把输入环境（尤其密钥）放入异常。
        throw new Error(
          `对象存储配置无效：${config.error.issues.map((issue) => issue.path.join('.')).join('、')}`,
        );
      }
      this.bucket = config.data.S3_BUCKET;
      this.s3 = new S3Client({
        region: config.data.S3_REGION,
        endpoint: config.data.S3_ENDPOINT,
        forcePathStyle: true,
        credentials: {
          accessKeyId: config.data.S3_ACCESS_KEY_ID,
          secretAccessKey: config.data.S3_SECRET_ACCESS_KEY,
        },
      });
    }
  }

  onModuleDestroy() {
    this.s3?.destroy();
  }
  async put(
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<{ storageType: string; storageKey: string }> {
    const key = randomUUID();
    if (this.mode === 's3') {
      if (!this.s3 || !this.bucket) throw new Error('S3_BUCKET 未配置');
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: mimeType,
        }),
      );
    } else if (this.mode === 'local') {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(join(this.directory, key), bytes, {
        mode: 0o600,
        flag: 'wx',
      });
    } else throw new Error('STORAGE_DRIVER 仅支持 local 或 s3');
    return { storageType: this.mode, storageKey: key };
  }
  async get(storageType: string, key: string): Promise<Uint8Array> {
    if (!/^[a-f0-9-]{36}$/.test(key)) throw new Error('素材存储标识无效');
    if (storageType === 'local') return readFile(join(this.directory, key));
    if (storageType === 's3' && this.s3 && this.bucket) {
      const result = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!result.Body) throw new Error('素材内容为空');
      return result.Body.transformToByteArray();
    }
    throw new Error('当前部署无法读取该素材存储类型');
  }
}
