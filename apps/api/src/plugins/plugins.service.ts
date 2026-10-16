import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  createConnectionSchema,
  type Capability,
  type ModelSelection,
  type PluginConnection,
} from '@dramaflow/contracts';
import {
  assertProviderCapability,
  getProvider,
  validateProviderConnection,
  listPluginManifests,
} from '@dramaflow/plugins';
import { z } from 'zod';
import { AccessService } from '../auth/access.service.js';
import { DatabaseService } from '../infrastructure/database.service.js';
import { SecretsService } from '../infrastructure/secrets.service.js';
import { json, parse } from '../infrastructure/validation.js';

export function assertTrustedEndpoint(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const url = new URL(parse(z.url(), value));
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new BadRequestException(
      '模型地址必须使用 HTTP(S)，不得包含凭证、查询参数或片段',
    );
  const allowed = (
    process.env.MODEL_ENDPOINT_ALLOWLIST ?? 'https://api.openai.com'
  )
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!allowed.includes(url.origin))
    throw new BadRequestException(
      '此模型地址尚未被部署管理员加入 MODEL_ENDPOINT_ALLOWLIST',
    );
  return url.toString().replace(/\/$/, '');
}

@Injectable()
export class PluginsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly secrets: SecretsService,
  ) {}
  async list(userId: string, workspaceId: string) {
    await this.access.workspace(userId, workspaceId);
    const installed = await this.db.client.pluginInstallation.findMany({
      where: { workspaceId },
    });
    return {
      items: listPluginManifests().map((manifest) => ({
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        enabled: installed.some(
          (item) =>
            item.pluginId === manifest.id &&
            item.pluginVersion === manifest.version &&
            item.enabled,
        ),
        manifest,
      })),
    };
  }
  async setEnabled(
    userId: string,
    workspaceId: string,
    pluginId: string,
    body: unknown,
  ) {
    await this.access.workspace(userId, workspaceId, 'admin');
    const input = parse(
      z
        .object({
          enabled: z.boolean(),
          pluginVersion: z.string().default('1.0.0'),
        })
        .strict(),
      body,
    );
    const provider = getProvider(pluginId, input.pluginVersion);
    await this.db.client.pluginInstallation.upsert({
      where: {
        workspaceId_pluginId_pluginVersion: {
          workspaceId,
          pluginId,
          pluginVersion: input.pluginVersion,
        },
      },
      create: {
        workspaceId,
        pluginId,
        pluginVersion: input.pluginVersion,
        enabled: input.enabled,
      },
      update: { enabled: input.enabled },
    });
    return {
      pluginId,
      pluginVersion: input.pluginVersion,
      enabled: input.enabled,
      manifest: provider.manifest,
    };
  }
  async connections(
    userId: string,
    workspaceId: string,
  ): Promise<{ items: PluginConnection[] }> {
    await this.access.workspace(userId, workspaceId);
    const rows = await this.db.client.modelConnection.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        workspaceId,
        name: row.name,
        pluginId: row.pluginId,
        pluginVersion: row.pluginVersion,
        configuration: parse(z.record(z.string(), z.json()), row.configuration),
        hasCredential: true,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }
  async createConnection(
    userId: string,
    workspaceId: string,
    body: unknown,
  ): Promise<PluginConnection> {
    await this.access.workspace(userId, workspaceId, 'admin');
    const input = parse(createConnectionSchema, body);
    const provider = getProvider(input.pluginId, input.pluginVersion);
    const configuration = validateProviderConnection(
      provider,
      input.configuration,
    );
    assertTrustedEndpoint(configuration.baseUrl);
    const installation = await this.db.client.pluginInstallation.findUnique({
      where: {
        workspaceId_pluginId_pluginVersion: {
          workspaceId,
          pluginId: input.pluginId,
          pluginVersion: input.pluginVersion,
        },
      },
    });
    if (!installation?.enabled)
      throw new BadRequestException('请先启用此模型插件');
    const row = await this.db.client.modelConnection.create({
      data: {
        workspaceId,
        name: input.name,
        pluginId: input.pluginId,
        pluginVersion: input.pluginVersion,
        configuration: json(configuration),
        encryptedSecret: this.secrets.encrypt(input.credential, workspaceId),
      },
    });
    return {
      id: row.id,
      workspaceId,
      name: row.name,
      pluginId: row.pluginId,
      pluginVersion: row.pluginVersion,
      configuration,
      hasCredential: true,
      createdAt: row.createdAt.toISOString(),
    };
  }
  async resolve(
    workspaceId: string,
    model: ModelSelection,
    capability: Capability,
  ) {
    const connection = await this.db.client.modelConnection.findFirst({
      where: {
        id: model.connectionId,
        workspaceId,
        pluginId: model.pluginId,
        pluginVersion: model.pluginVersion,
      },
    });
    if (!connection)
      throw new NotFoundException('所选模型连接不存在或与插件不匹配');
    const installation = await this.db.client.pluginInstallation.findUnique({
      where: {
        workspaceId_pluginId_pluginVersion: {
          workspaceId,
          pluginId: model.pluginId,
          pluginVersion: model.pluginVersion,
        },
      },
    });
    if (!installation?.enabled)
      throw new BadRequestException('所选模型插件未启用');
    const provider = getProvider(model.pluginId, model.pluginVersion);
    assertProviderCapability(provider, capability);
    const config = parse(
      z.record(z.string(), z.json()),
      connection.configuration,
    );
    return {
      provider,
      connection,
      context: {
        apiKey: this.secrets.decrypt(connection.encryptedSecret, workspaceId),
        baseUrl: assertTrustedEndpoint(config.baseUrl),
      },
    };
  }
}
