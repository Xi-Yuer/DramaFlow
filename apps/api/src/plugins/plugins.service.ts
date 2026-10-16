import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  installationSummarySchema,
  installPluginSchema,
  remoteModelListSchema,
  updateInstallationSchema,
} from '@dramaflow/contracts';
import {
  ModelListError,
  listRemoteModels,
  normalizeCredentials,
  pluginById,
  publicCredentials,
  systemPlugins,
} from '@dramaflow/plugins';
import { DatabaseService } from '../infrastructure/database.service.js';
import { SecretsService } from '../infrastructure/secrets.service.js';

@Injectable()
export class PluginsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly secrets: SecretsService,
  ) {}
  catalog() {
    return { items: systemPlugins };
  }
  async list(ownerId: string) {
    const items = await this.db.client.pluginInstallation.findMany({
      where: { ownerId },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        pluginId: true,
        pluginVersion: true,
        label: true,
        secretCipher: true,
        updatedAt: true,
      },
    });
    return {
      items: items.flatMap((item) => {
        const manifest = pluginById(item.pluginId);
        if (!manifest) return [];
        return [
          installationSummarySchema.parse({
            id: item.id,
            pluginId: item.pluginId,
            pluginVersion: item.pluginVersion,
            label: item.label,
            publicConfig: publicCredentials(
              manifest,
              this.readCredentials(item.secretCipher, ownerId),
            ),
            updatedAt: item.updatedAt.toISOString(),
          }),
        ];
      }),
    };
  }
  async install(ownerId: string, raw: unknown) {
    const input = this.parse(installPluginSchema, raw);
    const manifest = this.manifest(input.pluginId);
    const credentials = this.credentials(manifest, input.credentials);
    const created = await this.db.client.pluginInstallation.create({
      data: {
        ownerId,
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        label: input.label,
        secretCipher: this.secrets.encrypt(
          JSON.stringify(credentials),
          ownerId,
        ),
      },
      select: {
        id: true,
        pluginId: true,
        pluginVersion: true,
        label: true,
        updatedAt: true,
      },
    });
    return installationSummarySchema.parse({
      ...created,
      publicConfig: publicCredentials(manifest, credentials),
      updatedAt: created.updatedAt.toISOString(),
    });
  }
  async update(ownerId: string, rawId: string, raw: unknown) {
    const id = z.string().uuid().parse(rawId);
    const input = this.parse(updateInstallationSchema, raw);
    const current = await this.owned(ownerId, id);
    const manifest = this.manifest(current.pluginId);
    const credentials = this.credentials(
      manifest,
      input.credentials,
      this.readCredentials(current.secretCipher, ownerId),
    );
    const updated = await this.db.client.pluginInstallation.update({
      where: { id },
      data: {
        label: input.label,
        pluginVersion: manifest.version,
        secretCipher: this.secrets.encrypt(
          JSON.stringify(credentials),
          ownerId,
        ),
      },
      select: {
        id: true,
        pluginId: true,
        pluginVersion: true,
        label: true,
        updatedAt: true,
      },
    });
    return installationSummarySchema.parse({
      ...updated,
      publicConfig: publicCredentials(manifest, credentials),
      updatedAt: updated.updatedAt.toISOString(),
    });
  }
  async models(ownerId: string, rawId: string) {
    const id = z.string().uuid().safeParse(rawId);
    if (!id.success) throw new NotFoundException('插件安装不存在或无权访问');
    const current = await this.owned(ownerId, id.data);
    const manifest = this.manifest(current.pluginId);
    try {
      const listed = await listRemoteModels(
        manifest,
        this.readCredentials(current.secretCipher, ownerId),
      );
      return remoteModelListSchema.parse(listed);
    } catch (error) {
      if (error instanceof ModelListError)
        throw new BadRequestException(error.message);
      throw error;
    }
  }
  async remove(ownerId: string, rawId: string) {
    const id = z.string().uuid().parse(rawId);
    await this.owned(ownerId, id);
    await this.db.client.pluginInstallation.delete({ where: { id } });
    return { success: true };
  }
  private manifest(id: string) {
    const manifest = pluginById(id);
    if (!manifest) throw new NotFoundException('插件不存在');
    return manifest;
  }
  private async owned(ownerId: string, id: string) {
    const installation = await this.db.client.pluginInstallation.findFirst({
      where: { id, ownerId },
    });
    if (!installation) throw new NotFoundException('插件安装不存在或无权访问');
    return installation;
  }
  private readCredentials(cipher: string, ownerId: string) {
    const parsed: unknown = JSON.parse(this.secrets.decrypt(cipher, ownerId));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new BadRequestException('已保存的插件凭证无法读取');
    const credentials: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed))
      if (typeof value === 'string') credentials[key] = value;
    return credentials;
  }
  private credentials(
    manifest: ReturnType<typeof this.manifest>,
    incoming: Record<string, string>,
    previous?: Record<string, string>,
  ) {
    try {
      return normalizeCredentials(manifest, incoming, previous);
    } catch (error) {
      if (error instanceof z.ZodError)
        throw new BadRequestException(
          error.issues[0]?.message ?? '插件凭证不符合要求',
        );
      throw new BadRequestException(
        error instanceof Error ? error.message : '插件凭证不符合要求',
      );
    }
  }
  private parse<T>(schema: z.ZodType<T>, value: unknown) {
    const result = schema.safeParse(value);
    if (!result.success)
      throw new BadRequestException(
        result.error.issues[0]?.message ?? '插件配置不符合协议',
      );
    return result.data;
  }
}
