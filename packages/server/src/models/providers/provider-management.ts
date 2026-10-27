import {
  createModelProviderSchema,
  createCatalogProviderSchema,
  modelManagementListQuerySchema,
  modelProviderListSchema,
  setModelResourceEnabledRequestSchema,
  type CreateModelProvider,
  type ModelProvider,
} from '@dramaflow/contracts';
import type { PluginRegistry, ProviderCatalog } from '@dramaflow/plugins';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { DatabaseService } from '../../database/database.service.js';
import type { SecretsService } from '../../secrets/secrets.service.js';
import { ModelConfigurationError } from '../shared/model-configuration-error.js';
import { jsonObject } from '../shared/model-json.js';
import { pageAfter } from '../shared/model-pagination.js';
import { providerDto, providerSelect } from './provider-record.js';

export class ProviderManagement {
  constructor(
    private readonly db: DatabaseService,
    private readonly secrets: SecretsService,
    private readonly plugins: PluginRegistry,
    private readonly catalog: ProviderCatalog,
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
}
