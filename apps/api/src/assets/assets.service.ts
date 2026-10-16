import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import type { AssetVersion, JsonObject } from '@dramaflow/contracts';
import { AccessService } from '../auth/access.service.js';
import { DatabaseService } from '../infrastructure/database.service.js';
import { json, parse } from '../infrastructure/validation.js';
import { StorageService } from './storage.service.js';

const maxAssetBytes = 25 * 1024 * 1024;
const uploadSchema = z
  .object({
    name: z.string().min(1).max(250),
    type: z.enum(['image', 'video', 'audio', 'file']),
    mimeType: z.string().min(1).max(100),
    contentBase64: z
      .string()
      .min(1)
      .max(Math.ceil((maxAssetBytes * 4) / 3) + 4),
  })
  .strict();

@Injectable()
export class AssetsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly storage: StorageService,
  ) {}
  async list(
    userId: string,
    workspaceId: string,
  ): Promise<{ items: AssetVersion[] }> {
    await this.access.workspace(userId, workspaceId);
    const rows = await this.db.client.assetVersion.findMany({
      where: { asset: { workspaceId } },
      include: { asset: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return {
      items: rows.map((row) => ({
        assetId: row.assetId,
        versionId: row.id,
        workspaceId,
        type: this.kind(row.asset.kind),
        mimeType: row.mimeType,
        name: row.asset.name,
        size: row.size,
        createdAt: row.createdAt.toISOString(),
        metadata: row.metadata as JsonObject,
      })),
    };
  }
  private kind(value: string): AssetVersion['type'] {
    return parse(z.enum(['image', 'video', 'audio', 'file']), value);
  }
  async upload(
    userId: string,
    workspaceId: string,
    body: unknown,
  ): Promise<AssetVersion> {
    await this.access.workspace(userId, workspaceId, 'editor');
    const input = parse(uploadSchema, body);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64))
      throw new BadRequestException('素材编码无效');
    return this.save(
      workspaceId,
      input.name,
      input.type,
      input.mimeType,
      Buffer.from(input.contentBase64, 'base64'),
    );
  }
  async save(
    workspaceId: string,
    name: string,
    type: AssetVersion['type'],
    mimeType: string,
    bytes: Uint8Array,
    metadata: JsonObject = {},
    assetId?: string,
  ): Promise<AssetVersion> {
    if (assetId) {
      const existing = await this.db.client.asset.findFirst({
        where: { id: assetId, workspaceId },
        include: { versions: { orderBy: { number: 'desc' }, take: 1 } },
      });
      const version = existing?.versions[0];
      if (existing && version)
        return {
          assetId: existing.id,
          versionId: version.id,
          workspaceId,
          type: this.kind(existing.kind),
          mimeType: version.mimeType,
          name: existing.name,
          size: version.size,
          metadata: version.metadata as JsonObject,
          createdAt: version.createdAt.toISOString(),
        };
    }
    if (!bytes.length || bytes.length > maxAssetBytes)
      throw new BadRequestException('素材大小必须在 1 字节至 25 MiB 之间');
    const stored = await this.storage.put(bytes, mimeType);
    const row = await this.db.client.asset.create({
      data: {
        ...(assetId ? { id: assetId } : {}),
        workspaceId,
        name,
        kind: type,
        versions: {
          create: {
            number: 1,
            mimeType,
            size: bytes.length,
            checksum: createHash('sha256').update(bytes).digest('hex'),
            ...stored,
            metadata: json(metadata),
          },
        },
      },
      include: { versions: true },
    });
    const version = row.versions[0];
    if (!version) throw new Error('素材版本保存失败');
    return {
      assetId: row.id,
      versionId: version.id,
      workspaceId,
      type,
      mimeType,
      name,
      size: version.size,
      metadata,
      createdAt: version.createdAt.toISOString(),
    };
  }
  async content(userId: string, versionId: string) {
    const row = await this.db.client.assetVersion.findUnique({
      where: { id: versionId },
      include: { asset: true },
    });
    if (!row) throw new NotFoundException('素材不存在');
    await this.access.workspace(userId, row.asset.workspaceId);
    return {
      row,
      bytes: await this.storage.get(row.storageType, row.storageKey),
    };
  }
  async contextAssets(
    userId: string,
    workspaceId: string,
    versionIds: string[],
  ) {
    await this.access.workspace(userId, workspaceId);
    return Promise.all(
      versionIds.map(async (versionId) => {
        const row = await this.db.client.assetVersion.findFirst({
          where: { id: versionId, asset: { workspaceId } },
          include: { asset: true },
        });
        if (!row)
          throw new BadRequestException(
            `选定素材不存在或无权访问：${versionId}`,
          );
        const text =
          row.mimeType.startsWith('text/') && row.size <= 100000
            ? Buffer.from(
                await this.storage.get(row.storageType, row.storageKey),
              ).toString('utf8')
            : undefined;
        return {
          id: row.assetId,
          versionId,
          name: row.asset.name,
          type: row.asset.kind,
          ...(text ? { text } : {}),
        };
      }),
    );
  }
}
