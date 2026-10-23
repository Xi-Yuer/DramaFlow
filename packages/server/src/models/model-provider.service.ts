import {
  createModelProviderSchema,
  createModelConfigurationSchema,
  modelProviderSchema,
  modelConfigurationSchema,
  type CreateModelProvider,
  type CreateModelConfiguration,
  type ModelProvider,
  type ModelConfiguration,
  type ModelAvailability,
  managedModelConfigurationSchema,
  modelProviderListSchema,
  modelConfigurationListSchema,
  setModelResourceEnabledRequestSchema,
  modelManagementListQuerySchema,
  providerPluginCatalogSchema,
  providerCatalogSchema,
  createCatalogProviderSchema,
  modelCatalogSchema,
  type ModelCatalogItem,
} from '@dramaflow/contracts';
import { ModelCatalog, PluginRegistry, ProviderCatalog } from '@dramaflow/plugins';
import type { Prisma } from '@dramaflow/database';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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

// 读取路径从数据库投影中排除密文，不依靠序列化时删除秘密字段。
const providerSelect = {
  id: true,
  ownerId: true,
  name: true,
  pluginId: true,
  pluginVersion: true,
  configuration: true,
  providerDefinitionId: true,
  enabled: true,
  createdAt: true,
} satisfies Prisma.ModelProviderSelect;
const modelSelect = {
  id: true,
  ownerId: true,
  providerId: true,
  capability: true,
  model: true,
  settings: true,
  enabled: true,
  createdAt: true,
  provider: { select: providerSelect },
} satisfies Prisma.ModelConfigurationSelect;
type ProviderRow = Prisma.ModelProviderGetPayload<{ select: typeof providerSelect }>;
type ModelRow = Prisma.ModelConfigurationGetPayload<{ select: typeof modelSelect }>;
function providerDto(row: ProviderRow): ModelProvider {
  return modelProviderSchema.parse({
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    pluginId: row.pluginId,
    pluginVersion: row.pluginVersion,
    configuration: row.configuration,
    providerDefinitionId: row.providerDefinitionId,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  });
}
function pageAfter(cursor: { id: string; createdAt: Date } | null) {
  return cursor
    ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      }
    : {};
}

@Injectable()
export class ModelProviderService {
  constructor(
    private readonly db: DatabaseService,
    private readonly secrets: SecretsService,
    private readonly plugins: PluginRegistry,
    private readonly catalog: ProviderCatalog,
    private readonly modelCatalog: ModelCatalog,
  ) {}

  async createProvider(ownerId: string, input: CreateModelProvider): Promise<ModelProvider> {
    const parsed = createModelProviderSchema.safeParse(input);
    if (!parsed.success) throw new ModelConfigurationError('MODEL_PROVIDER_CONFIGURATION_INVALID');
    const value = parsed.data;
    let configuration: z.infer<typeof jsonObject>;
    let credentials: Record<string, string>;
    try {
      const plugin = this.plugins.getConfigurable(value.pluginId, value.pluginVersion);
      configuration = jsonObject.parse(plugin.configSchema.parse(value.configuration));
      credentials = z
        .record(z.string(), z.string())
        .parse(plugin.credentialsSchema.parse(value.credentials));
    } catch {
      throw new ModelConfigurationError('MODEL_PROVIDER_CONFIGURATION_INVALID');
    }
    const row = await this.db.client.modelProvider.create({
      data: {
        ownerId,
        name: value.name,
        pluginId: value.pluginId,
        pluginVersion: value.pluginVersion,
        configuration,
        encryptedCredentials: this.secrets.encrypt(JSON.stringify(credentials), ownerId),
      },
    });
    return providerDto(row);
  }

  async createProviderFromCatalog(ownerId: string, input: unknown): Promise<ModelProvider> {
    const parsed = createCatalogProviderSchema.safeParse(input);
    if (!parsed.success) throw new ModelConfigurationError('MODEL_PROVIDER_CONFIGURATION_INVALID');
    const value = parsed.data;
    let materialized;
    try {
      materialized = this.catalog.materialize(value.providerDefinitionId, {
        ...(value.configuration === undefined ? {} : { configuration: value.configuration }),
        credentials: value.credentials,
      });
    } catch {
      throw new ModelConfigurationError('MODEL_PROVIDER_CONFIGURATION_INVALID');
    }
    const row = await this.db.client.modelProvider.create({
      data: {
        ownerId,
        name: value.name,
        pluginId: materialized.pluginId,
        pluginVersion: materialized.pluginVersion,
        configuration: materialized.configuration,
        providerDefinitionId: materialized.providerDefinitionId,
        encryptedCredentials: this.secrets.encrypt(
          JSON.stringify(materialized.credentials),
          ownerId,
        ),
      },
    });
    return providerDto(row);
  }

  listProviderCatalog() {
    return providerCatalogSchema.parse({ items: this.catalog.list() });
  }

  listModelCatalog(capability?: string): { items: ModelCatalogItem[] } {
    return modelCatalogSchema.parse({ items: this.modelCatalog.list(capability) });
  }

  async createModelConfiguration(
    ownerId: string,
    input: CreateModelConfiguration,
  ): Promise<ModelConfiguration> {
    const parsed = createModelConfigurationSchema.safeParse(input);
    if (!parsed.success) throw new ModelConfigurationError('MODEL_CONFIGURATION_INVALID');
    const value = parsed.data;
    const provider = await this.db.client.modelProvider.findFirst({
      where: {
        id: value.providerId,
        ownerId,
      },
      select: providerSelect,
    });
    if (!provider) throw new NotFoundException('Provider 不存在或无权访问');
    if (!provider.enabled) throw new ModelConfigurationError('MODEL_PROVIDER_UNAVAILABLE');
    let settings: z.infer<typeof jsonObject>;
    try {
      const plugin = this.plugins.getConfigurable(provider.pluginId, provider.pluginVersion);
      jsonObject.parse(plugin.configSchema.parse(provider.configuration));
      settings = jsonObject.parse(
        this.plugins
          .getCapability(provider.pluginId, provider.pluginVersion, value.capability)
          .modelSettingsSchema.parse(value.settings),
      );
    } catch {
      throw new ModelConfigurationError('MODEL_CONFIGURATION_INVALID');
    }
    const row = await this.db.client.modelConfiguration.create({
      data: { ...value, ownerId, settings },
    });
    return modelConfigurationSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
  }

  async getModelConfiguration(ownerId: string, id: string): Promise<ModelConfiguration | null> {
    const row = await this.db.client.modelConfiguration.findFirst({
      where: {
        id: z.uuid().parse(id),
        ownerId,
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
      JOIN "model_provider" p ON p."id" = m."providerId" AND p."ownerId" = m."ownerId"
      WHERE m."id" = ${z.uuid().parse(id)}::uuid AND m."ownerId" = ${ownerId}
      FOR SHARE OF m, p
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
    providerId: string,
    credentials: Record<string, string>,
  ): Promise<void> {
    const provider = await this.db.client.modelProvider.findFirst({
      where: {
        id: z.uuid().parse(providerId),
        ownerId,
      },
      select: providerSelect,
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
        ownerId,
      },
      data: { encryptedCredentials: this.secrets.encrypt(JSON.stringify(parsed), ownerId) },
    });
    if (changed.count !== 1) throw new NotFoundException('Provider 不存在或无权访问');
  }

  listProviderPlugins() {
    return providerPluginCatalogSchema.parse({ items: this.plugins.listConfigurable() });
  }

  async getProvider(ownerId: string, providerId: string): Promise<ModelProvider> {
    const row = await this.db.client.modelProvider.findFirst({
      where: { id: z.uuid().parse(providerId), ownerId },
      select: providerSelect,
    });
    if (!row) throw new NotFoundException('Provider 不存在或无权访问');
    return providerDto(row);
  }

  async listProviders(ownerId: string, query: unknown) {
    const { cursor } = modelManagementListQuerySchema.parse(query);
    const where = { ownerId };
    const after = cursor
      ? await this.db.client.modelProvider.findFirst({
          where: { ...where, id: cursor },
          select: { id: true, createdAt: true },
        })
      : null;
    if (cursor && !after) throw new BadRequestException('分页游标无效');
    const rows = await this.db.client.modelProvider.findMany({
      where: { ...where, ...pageAfter(after) },
      select: providerSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
    });
    return modelProviderListSchema.parse({
      items: rows.slice(0, 50).map(providerDto),
      nextCursor: rows.length > 50 ? rows[49]!.id : null,
    });
  }

  async setProviderEnabled(ownerId: string, providerId: string, enabled: boolean) {
    const value = setModelResourceEnabledRequestSchema.parse({ enabled });
    const changed = await this.db.client.modelProvider.updateMany({
      where: { id: z.uuid().parse(providerId), ownerId },
      data: value,
    });
    if (changed.count !== 1) throw new NotFoundException('Provider 不存在或无权访问');
    return this.getProvider(ownerId, providerId);
  }

  private availability(row: ModelRow): ModelAvailability {
    const unavailable = (
      unavailableReason: ModelAvailability['unavailableReason'],
    ): ModelAvailability => ({ selectable: false, unavailableReason });
    if (!row.enabled) return unavailable('MODEL_DISABLED');
    if (!row.provider.enabled) return unavailable('PROVIDER_DISABLED');
    let plugin;
    try {
      plugin = this.plugins.get(row.provider.pluginId, row.provider.pluginVersion);
    } catch {
      return unavailable('PLUGIN_UNAVAILABLE');
    }
    const capability = plugin.capabilities.find((item) => item.type === row.capability);
    if (!capability) return unavailable('CAPABILITY_UNAVAILABLE');
    try {
      jsonObject.parse(plugin.configSchema.parse(row.provider.configuration));
      jsonObject.parse(capability.modelSettingsSchema.parse(row.settings));
      createModelConfigurationSchema.shape.model.parse(row.model);
    } catch {
      return unavailable('CONFIGURATION_INVALID');
    }
    return { selectable: true, unavailableReason: null };
  }

  private managedModelDto(row: ModelRow) {
    return managedModelConfigurationSchema.parse({
      id: row.id,
      ownerId: row.ownerId,
      providerId: row.providerId,
      capability: row.capability,
      model: row.model,
      settings: row.settings,
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      availability: this.availability(row),
    });
  }

  async getManagedModelConfiguration(ownerId: string, id: string) {
    const row = await this.db.client.modelConfiguration.findFirst({
      where: { id: z.uuid().parse(id), ownerId },
      select: modelSelect,
    });
    if (!row) throw new NotFoundException('模型配置不存在或无权访问');
    return this.managedModelDto(row);
  }

  async listModelConfigurations(ownerId: string, query: unknown) {
    const { cursor } = modelManagementListQuerySchema.parse(query);
    const where = { ownerId };
    const after = cursor
      ? await this.db.client.modelConfiguration.findFirst({
          where: { ...where, id: cursor },
          select: { id: true, createdAt: true },
        })
      : null;
    if (cursor && !after) throw new BadRequestException('分页游标无效');
    const rows = await this.db.client.modelConfiguration.findMany({
      where: { ...where, ...pageAfter(after) },
      select: modelSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
    });
    return modelConfigurationListSchema.parse({
      items: rows.slice(0, 50).map((row) => this.managedModelDto(row)),
      nextCursor: rows.length > 50 ? rows[49]!.id : null,
    });
  }

  async setModelEnabled(ownerId: string, id: string, enabled: boolean) {
    const value = setModelResourceEnabledRequestSchema.parse({ enabled });
    const changed = await this.db.client.modelConfiguration.updateMany({
      where: { id: z.uuid().parse(id), ownerId },
      data: value,
    });
    if (changed.count !== 1) throw new NotFoundException('模型配置不存在或无权访问');
    return this.getManagedModelConfiguration(ownerId, id);
  }
}
