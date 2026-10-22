import { describe, expect, it } from 'vitest';
import {
  describeSelection,
  filterSelectorGroups,
  groupSelectorModels,
  modelsForCapabilities,
  type CatalogModelRef,
  type SelectorConfiguration,
  type SelectorProviderInstance,
} from '../src/features/workflow/model-selector-options';

const openai = '00000000-0000-4000-8000-000000000021';
const anthropic = '00000000-0000-4000-8000-000000000022';
const gpt = '00000000-0000-4000-8000-000000000031';
const claude = '00000000-0000-4000-8000-000000000032';
const definitions = [
  { id: 'anthropic', displayName: 'Anthropic' },
  { id: 'openai', displayName: 'OpenAI' },
];
const catalog: CatalogModelRef[] = [
  {
    id: 'claude-sonnet-4-20250514',
    displayName: 'Claude Sonnet 4',
    providerDefinitionId: 'anthropic',
    capabilities: [{ type: 'text.generate' }],
  },
  {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    providerDefinitionId: 'openai',
    capabilities: [{ type: 'text.generate' }],
  },
  {
    id: 'gpt-image',
    displayName: 'GPT Image',
    providerDefinitionId: 'openai',
    capabilities: [{ type: 'image.generate' }],
  },
];

function provider(overrides: Partial<SelectorProviderInstance> = {}): SelectorProviderInstance {
  return {
    id: openai,
    providerDefinitionId: 'openai',
    enabled: true,
    createdAt: '2026-10-22T00:00:00.000Z',
    ...overrides,
  };
}
function configuration(overrides: Partial<SelectorConfiguration> = {}): SelectorConfiguration {
  return {
    id: gpt,
    providerId: openai,
    capability: 'text.generate',
    model: 'gpt-4o',
    createdAt: '2026-10-22T00:00:01.000Z',
    settings: { maxOutputTokens: 128 },
    availability: { selectable: true, unavailableReason: null },
    ...overrides,
  };
}

describe('文本模型选择分组', () => {
  it('只保留节点声明的能力，并按目录中的供应商分组', () => {
    const visible = modelsForCapabilities(catalog, ['text.generate']);
    expect(visible.map((item) => item.displayName)).toEqual(['Claude Sonnet 4', 'GPT-4o']);
    const groups = groupSelectorModels({
      catalog: visible,
      definitions,
      providers: [],
      configurations: [],
      capability: 'text.generate',
    });
    expect(groups.map((group) => group.providerName)).toEqual(['Anthropic', 'OpenAI']);
    expect(groups.every((group) => group.models.every((model) => model.status.kind === 'unconfigured'))).toBe(
      true,
    );
  });

  it('已有可执行配置时可直接对应到 configuration id，目录项本身不是配置', () => {
    const [anthropicGroup, openaiGroup] = groupSelectorModels({
      catalog: modelsForCapabilities(catalog, ['text.generate']),
      definitions,
      providers: [provider(), provider({ id: anthropic, providerDefinitionId: 'anthropic' })],
      configurations: [configuration()],
      capability: 'text.generate',
    });
    expect(openaiGroup?.models[0]?.status).toEqual({
      kind: 'available',
      choices: [{ configurationId: gpt, detail: null }],
    });
    expect(anthropicGroup?.models[0]?.status).toEqual({ kind: 'not-added', providerId: anthropic });
    expect(openaiGroup?.models[0]).not.toHaveProperty('pluginId');
  });

  it('供应商已配置但目录模型没有配置时，给出可创建的供应商实例', () => {
    const groups = groupSelectorModels({
      catalog: modelsForCapabilities(catalog, ['text.generate']).slice(1),
      definitions,
      providers: [
        provider({ id: anthropic, createdAt: '2026-10-22T00:00:02.000Z' }),
        provider(),
      ],
      configurations: [],
      capability: 'text.generate',
    });
    expect(groups[0]?.models[0]?.status).toEqual({ kind: 'not-added', providerId: openai });
  });

  it('模型字符串相同但供应商定义不同，不能当作该目录模型可用', () => {
    const groups = groupSelectorModels({
      catalog: modelsForCapabilities(catalog, ['text.generate']).slice(1),
      definitions,
      providers: [provider(), provider({ id: anthropic, providerDefinitionId: 'anthropic' })],
      configurations: [configuration({ providerId: anthropic })],
      capability: 'text.generate',
    });
    expect(groups[0]?.models[0]?.status).toEqual({ kind: 'not-added', providerId: openai });
  });

  it('同一目录模型的多个可用配置保留各自的 configuration id', () => {
    const groups = groupSelectorModels({
      catalog: modelsForCapabilities(catalog, ['text.generate']).slice(1),
      definitions,
      providers: [provider()],
      configurations: [
        configuration({ settings: { maxOutputTokens: 64, temperature: 0.2 } }),
        configuration({
          id: claude,
          createdAt: '2026-10-22T00:00:03.000Z',
          settings: { maxOutputTokens: 256 },
        }),
      ],
      capability: 'text.generate',
    });
    expect(groups[0]?.models[0]?.status).toEqual({
      kind: 'available',
      choices: [
        { configurationId: gpt, detail: '最大输出 64 · 随机度 0.2' },
        { configurationId: claude, detail: '最大输出 256' },
      ],
    });
  });

  it('按模型名称或稳定模型 id 搜索，空结果不保留供应商分组', () => {
    const groups = groupSelectorModels({
      catalog: modelsForCapabilities(catalog, ['text.generate']),
      definitions,
      providers: [],
      configurations: [],
      capability: 'text.generate',
    });
    expect(filterSelectorGroups(groups, 'gpt').map((group) => group.providerName)).toEqual(['OpenAI']);
    expect(filterSelectorGroups(groups, 'claude-sonnet')[0]?.models[0]?.displayName).toBe('Claude Sonnet 4');
    expect(filterSelectorGroups(groups, '不存在')).toEqual([]);
  });

  it('已选配置恢复为目录显示名，找不到配置时不回显原始 id', () => {
    const visible = modelsForCapabilities(catalog, ['text.generate']);
    expect(
      describeSelection({
        configurationId: gpt,
        configurations: [configuration()],
        providers: [provider()],
        definitions,
        catalog: visible,
      }),
    ).toEqual({ label: 'GPT-4o', title: 'OpenAI · GPT-4o' });
    expect(
      describeSelection({
        configurationId: claude,
        configurations: [],
        providers: [],
        definitions,
        catalog: visible,
      }).label,
    ).toBe('模型配置不可用');
    expect(
      describeSelection({
        configurationId: undefined,
        configurations: [],
        providers: [],
        definitions,
        catalog: visible,
      }).label,
    ).toBe('选择模型');
  });
});
