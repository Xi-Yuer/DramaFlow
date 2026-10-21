import {
  createModelProviderSchema,
  createModelConfigurationSchema,
  modelProviderSchema,
  modelConfigurationSchema,
  type CreateModelProvider,
  type CreateModelConfiguration,
  type ModelProvider,
  type ModelConfiguration,
} from '@dramaflow/contracts';
import { PluginRegistry } from '@dramaflow/plugins';
import type { Prisma } from '@dramaflow/database';
import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import { SecretsService } from '../secrets/secrets.service.js';

const jsonObject = z.record(z.string(), z.json());
export class ModelConfigurationError extends Error {
  constructor(
    readonly code:
      | 'MODEL_PROVIDER_CONFIGURATION_INVALID'
      | 'MODEL_CONFIGURATION_INVALID'
      | 'MODEL_CONFIGURATION_UNAVAILABLE'
      | 'MODEL_PROVIDER_UNAVAILABLE'
      | 'MODEL_CREDENTIALS_UNAVAILABLE',
  ) {
    super('模型能力配置无效或不可用');
    this.name = 'ModelConfigurationError';
  }
}

@Injectable()
export class ModelProviderService {
  constructor(
    private readonly db: DatabaseService,
    private readonly secrets: SecretsService,
    private readonly plugins: PluginRegistry,
  ) {}

  private async authorize(ownerId: string, projectId: string): Promise<void> {
    const project = await this.db.client.project.findFirst({
      where: { id: z.uuid().parse(projectId), ownerId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('项目不存在或无权访问');
  }

  async createProvider(ownerId: string, input: CreateModelProvider): Promise<ModelProvider> {
    const parsed = createModelProviderSchema.safeParse(input);
    if (!parsed.success) throw new ModelConfigurationError('MODEL_PROVIDER_CONFIGURATION_INVALID');
    const value = parsed.data;
    await this.authorize(ownerId, value.projectId);
    let configuration: z.infer<typeof jsonObject>;
    let credentials: Record<string, string>;
    try {
      const plugin = this.plugins.get(value.pluginId, value.pluginVersion);
      configuration = jsonObject.parse(plugin.configSchema.parse(value.configuration));
      credentials = z
        .record(z.string(), z.string())
        .parse(plugin.credentialsSchema.parse(value.credentials));
    } catch {
      throw new ModelConfigurationError('MODEL_PROVIDER_CONFIGURATION_INVALID');
    }
    const row = await this.db.client.modelProvider.create({
      data: {
        projectId: value.projectId,
        name: value.name,
        pluginId: value.pluginId,
        pluginVersion: value.pluginVersion,
        configuration,
        encryptedCredentials: this.secrets.encrypt(JSON.stringify(credentials), ownerId),
      },
    });
    return modelProviderSchema.parse({
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      pluginId: row.pluginId,
      pluginVersion: row.pluginVersion,
      configuration: row.configuration,
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
    });
  }

  async createModelConfiguration(
    ownerId: string,
    input: CreateModelConfiguration,
  ): Promise<ModelConfiguration> {
    const parsed = createModelConfigurationSchema.safeParse(input);
    if (!parsed.success) throw new ModelConfigurationError('MODEL_CONFIGURATION_INVALID');
    const value = parsed.data;
    await this.authorize(ownerId, value.projectId);
    const provider = await this.db.client.modelProvider.findFirst({
      where: {
        id: value.providerId,
        projectId: value.projectId,
        project: { ownerId },
        enabled: true,
      },
    });
    if (!provider) throw new NotFoundException('Provider 不存在或无权访问');
    let settings: z.infer<typeof jsonObject>;
    try {
      settings = jsonObject.parse(
        this.plugins
          .getCapability(provider.pluginId, provider.pluginVersion, value.capability)
          .modelSettingsSchema.parse(value.settings),
      );
    } catch {
      throw new ModelConfigurationError('MODEL_CONFIGURATION_INVALID');
    }
    const row = await this.db.client.modelConfiguration.create({ data: { ...value, settings } });
    return modelConfigurationSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
  }

  async getModelConfiguration(
    ownerId: string,
    projectId: string,
    id: string,
  ): Promise<ModelConfiguration | null> {
    const row = await this.db.client.modelConfiguration.findFirst({
      where: {
        id: z.uuid().parse(id),
        projectId: z.uuid().parse(projectId),
        project: { ownerId },
      },
    });
    return row
      ? modelConfigurationSchema.parse({ ...row, createdAt: row.createdAt.toISOString() })
      : null;
  }

  // 只读取非秘密配置，使用调用方发布事务的连接；不解密、不调用能力或探活。
  async assertPublishableConfiguration(
    tx: Prisma.TransactionClient,
    ownerId: string,
    projectId: string,
    id: string,
    capability: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<
      {
        enabled: boolean;
        capability: string;
        model: string;
        settings: unknown;
        providerEnabled: boolean;
        pluginId: string;
        pluginVersion: number;
        configuration: unknown;
      }[]
    >`
      SELECT m."enabled", m."capability", m."model", m."settings",
             p."enabled" AS "providerEnabled", p."pluginId", p."pluginVersion", p."configuration"
      FROM "model_configuration" m
      JOIN "model_provider" p ON p."id" = m."providerId" AND p."projectId" = m."projectId"
      JOIN "canvas_project" project ON project."id" = m."projectId"
      WHERE m."id" = ${z.uuid().parse(id)}::uuid AND m."projectId" = ${projectId}::uuid
        AND project."ownerId" = ${ownerId}
      FOR SHARE OF m, p, project
    `;
    const model = rows[0];
    if (!model || !model.enabled || model.capability !== capability)
      throw new ModelConfigurationError('MODEL_CONFIGURATION_UNAVAILABLE');
    if (!model.providerEnabled) throw new ModelConfigurationError('MODEL_PROVIDER_UNAVAILABLE');
    try {
      const plugin = this.plugins.get(model.pluginId, model.pluginVersion);
      const implementation = this.plugins.getCapability(
        model.pluginId,
        model.pluginVersion,
        capability,
      );
      jsonObject.parse(plugin.configSchema.parse(model.configuration));
      jsonObject.parse(implementation.modelSettingsSchema.parse(model.settings));
      createModelConfigurationSchema.shape.model.parse(model.model);
    } catch {
      throw new ModelConfigurationError('MODEL_CONFIGURATION_INVALID');
    }
  }

  async replaceCredentials(
    ownerId: string,
    projectId: string,
    providerId: string,
    credentials: Record<string, string>,
  ): Promise<void> {
    const provider = await this.db.client.modelProvider.findFirst({
      where: {
        id: z.uuid().parse(providerId),
        projectId: z.uuid().parse(projectId),
        project: { ownerId },
      },
    });
    if (!provider) throw new NotFoundException('Provider 不存在或无权访问');
    let parsed: Record<string, string>;
    try {
      parsed = z
        .record(z.string(), z.string())
        .parse(
          this.plugins
            .get(provider.pluginId, provider.pluginVersion)
            .credentialsSchema.parse(credentials),
        );
    } catch {
      throw new ModelConfigurationError('MODEL_CREDENTIALS_UNAVAILABLE');
    }
    const changed = await this.db.client.modelProvider.updateMany({
      where: {
        id: provider.id,
        projectId,
        project: { ownerId },
      },
      data: { encryptedCredentials: this.secrets.encrypt(JSON.stringify(parsed), ownerId) },
    });
    if (changed.count !== 1) throw new NotFoundException('Provider 不存在或无权访问');
  }
}
