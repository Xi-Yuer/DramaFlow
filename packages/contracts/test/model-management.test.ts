import { describe, expect, it } from 'vitest';
import {
  createUserProviderRequestSchema,
  createUserCatalogProviderRequestSchema,
  createUserModelRequestSchema,
  setModelResourceEnabledRequestSchema,
  replaceProviderCredentialsRequestSchema,
  modelAvailabilitySchema,
  modelManagementListQuerySchema,
} from '../src/index.js';

describe('模型管理协议', () => {
  it('Owner 仅来自认证会话，创建和启停严格拒绝额外字段', () => {
    const provider = {
      name: '自选服务',
      pluginId: 'openai_compatible',
      pluginVersion: 1,
      configuration: { baseURL: 'http://localhost:8080/v1' },
      credentials: { apiKey: 'test-only' },
    };
    expect(createUserProviderRequestSchema.parse(provider)).toEqual(provider);
    const catalogProvider = {
      name: 'OpenAI',
      providerDefinitionId: 'openai',
      credentials: { apiKey: 'test-only' },
    };
    expect(createUserCatalogProviderRequestSchema.parse(catalogProvider)).toEqual(catalogProvider);
    expect(
      createUserCatalogProviderRequestSchema.safeParse({
        ...catalogProvider,
        pluginId: 'text_generation',
        projectId: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false);
    expect(
      createUserProviderRequestSchema.safeParse({ ...provider, projectId: 'spoof' }).success,
    ).toBe(false);
    expect(
      createUserProviderRequestSchema.safeParse({ ...provider, ownerId: 'spoof' }).success,
    ).toBe(false);
    const model = {
      providerId: '00000000-0000-4000-8000-000000000001',
      capability: 'text.generate',
      model: 'my-model',
      settings: {},
    };
    expect(createUserModelRequestSchema.parse(model)).toEqual(model);
    expect(createUserModelRequestSchema.safeParse({ ...model, enabled: false }).success).toBe(
      false,
    );
    expect(setModelResourceEnabledRequestSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
    for (const field of [
      'name',
      'model',
      'settings',
      'configuration',
      'pluginId',
      'credentials',
      'ownerId',
    ]) {
      expect(
        setModelResourceEnabledRequestSchema.safeParse({ enabled: true, [field]: 'changed' })
          .success,
      ).toBe(false);
    }
    expect(
      replaceProviderCredentialsRequestSchema.safeParse({
        credentials: { apiKey: 'new' },
        configuration: {},
      }).success,
    ).toBe(false);
  });
  it('可选性状态必须有一致的安全原因，列表仅接受有界游标', () => {
    expect(
      modelAvailabilitySchema.parse({ selectable: true, unavailableReason: null }),
    ).toBeDefined();
    expect(
      modelAvailabilitySchema.safeParse({
        selectable: true,
        unavailableReason: 'PROVIDER_DISABLED',
      }).success,
    ).toBe(false);
    expect(modelManagementListQuerySchema.safeParse({ limit: 100000 }).success).toBe(false);
  });
});
