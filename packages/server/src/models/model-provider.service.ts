import {
  modelCatalogSchema,
  providerCatalogSchema,
  providerPluginCatalogSchema,
  type CreateModelConfiguration,
  type CreateModelProvider,
  type ModelCatalogItem,
} from '@dramaflow/contracts';
import type { Prisma } from '@dramaflow/database';
import { ModelCatalog, PluginRegistry, ProviderCatalog } from '@dramaflow/plugins';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { ProviderManagement } from './providers/provider-management.js';
import { replaceProviderCredentials } from './providers/provider-credentials.js';
import { ModelConfigurations } from './configurations/model-configurations.js';
import { assertPublishableConfiguration } from './configurations/publish-model-configuration.js';

export { ModelConfigurationError } from './shared/model-configuration-error.js';

// 保留应用层入口与构造协议，内部实现按供应商、模型配置和发布检查分工。
@Injectable()
export class ModelProviderService {
  private readonly providers: ProviderManagement;
  private readonly configurations: ModelConfigurations;

  constructor(
    private readonly db: DatabaseService,
    private readonly secrets: SecretsService,
    private readonly plugins: PluginRegistry,
    private readonly catalog: ProviderCatalog,
    private readonly modelCatalog: ModelCatalog,
  ) {
    this.providers = new ProviderManagement(db, secrets, plugins, catalog);
    this.configurations = new ModelConfigurations(db, plugins);
  }

  createProvider(ownerId: string, input: CreateModelProvider) {
    return this.providers.createProvider(ownerId, input);
  }

  createProviderFromCatalog(ownerId: string, input: unknown) {
    return this.providers.createProviderFromCatalog(ownerId, input);
  }

  listProviderCatalog() {
    return providerCatalogSchema.parse({ items: this.catalog.list() });
  }

  listModelCatalog(capability?: string): { items: ModelCatalogItem[] } {
    return modelCatalogSchema.parse({ items: this.modelCatalog.list(capability) });
  }

  createModelConfiguration(ownerId: string, input: CreateModelConfiguration) {
    return this.configurations.createModelConfiguration(ownerId, input);
  }

  getModelConfiguration(ownerId: string, id: string) {
    return this.configurations.getModelConfiguration(ownerId, id);
  }

  assertPublishableConfiguration(
    tx: Prisma.TransactionClient,
    ownerId: string,
    id: string,
    capability: string,
  ): Promise<void> {
    return assertPublishableConfiguration(this.plugins, tx, ownerId, id, capability);
  }

  replaceCredentials(ownerId: string, providerId: string, credentials: Record<string, string>) {
    return replaceProviderCredentials(
      this.db,
      this.secrets,
      this.plugins,
      ownerId,
      providerId,
      credentials,
    );
  }

  listProviderPlugins() {
    return providerPluginCatalogSchema.parse({ items: this.plugins.listConfigurable() });
  }

  getProvider(ownerId: string, providerId: string) {
    return this.providers.getProvider(ownerId, providerId);
  }

  listProviders(ownerId: string, query: unknown) {
    return this.providers.listProviders(ownerId, query);
  }

  setProviderEnabled(ownerId: string, providerId: string, enabled: boolean) {
    return this.providers.setProviderEnabled(ownerId, providerId, enabled);
  }

  getManagedModelConfiguration(ownerId: string, id: string) {
    return this.configurations.getManagedModelConfiguration(ownerId, id);
  }

  listModelConfigurations(ownerId: string, query: unknown) {
    return this.configurations.listModelConfigurations(ownerId, query);
  }

  setModelEnabled(ownerId: string, id: string, enabled: boolean) {
    return this.configurations.setModelEnabled(ownerId, id, enabled);
  }
}
