import {
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { z } from 'zod';

/** 仅提供 RustFS 基础读写，不包含素材版本、权限或其他业务规则。 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor() {
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
      throw new Error(
        `对象存储配置无效：${config.error.issues.map((issue) => issue.path.join('.')).join('、')}`,
      );
    }
    this.bucket = config.data.S3_BUCKET;
    this.client = new S3Client({
      region: config.data.S3_REGION,
      endpoint: config.data.S3_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.data.S3_ACCESS_KEY_ID,
        secretAccessKey: config.data.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error('对象内容为空');
    return result.Body.transformToByteArray();
  }

  onModuleDestroy() {
    this.client.destroy();
  }
}
