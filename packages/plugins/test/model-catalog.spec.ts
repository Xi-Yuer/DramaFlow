import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_PROVIDER_ID,
  ModelCatalog,
  OPENAI_PROVIDER_ID,
  PluginRegistry,
  TextGenerationPlugin,
  createOfficialModelCatalog,
  createOfficialProviderCatalog,
} from '../src/index.js';

const catalog = () =>
  createOfficialModelCatalog(
    createOfficialProviderCatalog(new PluginRegistry([new TextGenerationPlugin()])),
  );

describe('官方 Model Catalog', () => {
  it('为 OpenAI 与 Anthropic 发布带能力的模型，且目录不含凭证或实现细节', () => {
    const items = catalog().list();
    expect(items).toEqual([
      {
        id: 'claude-sonnet-4-20250514',
        displayName: 'Claude Sonnet 4',
        providerDefinitionId: ANTHROPIC_PROVIDER_ID,
        capabilities: [{ type: 'text.generate', name: '文本生成' }],
      },
      {
        id: 'gpt-4o',
        displayName: 'GPT-4o',
        providerDefinitionId: OPENAI_PROVIDER_ID,
        capabilities: [{ type: 'text.generate', name: '文本生成' }],
      },
    ]);
    expect(JSON.stringify(items)).not.toMatch(
      /apiKey|credential|baseURL|pluginId|pluginVersion|secret|vercel|api\.openai\.com|api\.anthropic\.com/i,
    );
  });

  it('按 Capability 筛选，未知能力返回空目录', () => {
    const models = catalog();
    expect(models.list('text.generate').map((item) => item.id)).toEqual([
      'claude-sonnet-4-20250514',
      'gpt-4o',
    ]);
    expect(models.list('image.generate')).toEqual([]);
  });

  it('模型必须属于已发布 Provider，且只能声明该 Provider 已有的能力', () => {
    const providers = createOfficialProviderCatalog(
      new PluginRegistry([new TextGenerationPlugin()]),
    );
    expect(
      () =>
        new ModelCatalog(providers, [
          {
            id: 'gpt-4o',
            displayName: 'GPT-4o',
            providerDefinitionId: 'deepseek',
            capabilities: ['text.generate'],
          },
        ]),
    ).toThrow(expect.objectContaining({ code: 'PLUGIN_REGISTRATION_INVALID' }));
    expect(
      () =>
        new ModelCatalog(providers, [
          {
            id: 'gpt-image-1',
            displayName: 'GPT Image',
            providerDefinitionId: OPENAI_PROVIDER_ID,
            capabilities: ['image.generate'],
          },
        ]),
    ).toThrow(expect.objectContaining({ code: 'PLUGIN_REGISTRATION_INVALID' }));
    expect(
      () =>
        new ModelCatalog(providers, [
          {
            id: 'gpt-4o',
            displayName: 'GPT-4o',
            providerDefinitionId: OPENAI_PROVIDER_ID,
            capabilities: ['text.generate'],
          },
          {
            id: 'gpt-4o',
            displayName: '重复',
            providerDefinitionId: OPENAI_PROVIDER_ID,
            capabilities: ['text.generate'],
          },
        ]),
    ).toThrow(expect.objectContaining({ code: 'PLUGIN_REGISTRATION_INVALID' }));
  });
});
