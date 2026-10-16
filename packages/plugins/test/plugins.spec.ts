import { describe, expect, it } from 'vitest';
import { validateNodePlugins } from '@dramaflow/contracts';
import { foundationNodeDefinitions } from '@dramaflow/contracts';
import { listRemoteModels, normalizeCredentials, systemPlugins } from '@dramaflow/plugins';

describe('系统模型插件', () => {
  it('每个插件都有唯一标识，并且声明了密钥字段', () => {
    const ids = systemPlugins.map((plugin) => plugin.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      systemPlugins.every((plugin) => plugin.credentialFields.some((field) => field.secret)),
    ).toBe(true);
    expect(systemPlugins.some((plugin) => plugin.modelListing === 'openai')).toBe(true);
    expect(systemPlugins.find((plugin) => plugin.id === 'kling')?.modelListing).toBe('none');
  });
  it('创建时必须提供密钥，更新时留空则保留原密钥', () => {
    const deepseek = systemPlugins.find((plugin) => plugin.id === 'deepseek');
    if (!deepseek) throw new Error('缺少 DeepSeek 插件');
    expect(() => normalizeCredentials(deepseek, { apiKey: '' })).toThrow(/API Key/);
    const created = normalizeCredentials(deepseek, { apiKey: 'test-key' });
    expect(created.apiKey).toBe('test-key');
    expect(created.baseUrl).toBe('https://api.deepseek.com');
    const updated = normalizeCredentials(
      deepseek,
      { apiKey: '', baseUrl: 'https://example.com/v1' },
      created,
    );
    expect(updated.apiKey).toBe('test-key');
    expect(updated.baseUrl).toBe('https://example.com/v1');
  });
  it('节点只能选择能力匹配且属于自己的插件安装', () => {
    const llm = foundationNodeDefinitions.find((item) => item.type === 'drama.llm');
    if (!llm) throw new Error('缺少大模型节点');
    const node = {
      id: 'llm',
      type: 'drama.llm',
      version: 1,
      title: '写对白',
      position: { x: 0, y: 0 },
      config: {
        installationId: '11111111-1111-4111-8111-111111111111',
        modelId: 'deepseek-chat',
        instruction: '',
      },
    };
    const definition = { schemaVersion: 1 as const, nodes: [node], edges: [], bindings: [] };
    expect(
      validateNodePlugins(definition, [llm], [], systemPlugins).some(
        (issue) => issue.code === 'plugin_installation',
      ),
    ).toBe(true);
    expect(
      validateNodePlugins(
        definition,
        [llm],
        [{ id: node.config.installationId, pluginId: 'kling' }],
        systemPlugins,
      ).some((issue) => issue.code === 'plugin_capability'),
    ).toBe(true);
    expect(
      validateNodePlugins(
        definition,
        [llm],
        [{ id: node.config.installationId, pluginId: 'deepseek' }],
        systemPlugins,
      ),
    ).toEqual([]);
  });
  it('从厂商响应读取模型，不使用本地模型目录', async () => {
    const deepseek = systemPlugins.find((plugin) => plugin.id === 'deepseek');
    const anthropic = systemPlugins.find((plugin) => plugin.id === 'anthropic');
    const kling = systemPlugins.find((plugin) => plugin.id === 'kling');
    if (!deepseek || !anthropic || !kling) throw new Error('缺少插件');
    const calls: { url: string; authorization: string | null; apiKey: string | null }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        authorization: headers.get('Authorization'),
        apiKey: headers.get('x-api-key'),
      });
      const url = String(input);
      const body = url.includes('after_id')
        ? { data: [{ id: 'claude-haiku', display_name: 'Haiku' }], has_more: false }
        : url.includes('anthropic')
          ? {
              data: [{ id: 'claude-sonnet', display_name: 'Sonnet' }],
              has_more: true,
            }
          : { data: [{ id: 'models/deepseek-v4' }, { id: 'deepseek-v4' }] };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const credentials = { apiKey: 'test-key', baseUrl: 'https://api.deepseek.com' };
    const listed = await listRemoteModels(deepseek, credentials, fetchImpl);
    expect(listed.items).toEqual([{ id: 'deepseek-v4', label: 'deepseek-v4' }]);
    expect(calls[0]?.url).toBe('https://api.deepseek.com/models');
    expect(calls[0]?.authorization).toBe('Bearer test-key');
    const claude = await listRemoteModels(
      anthropic,
      { apiKey: 'claude-key', baseUrl: 'https://api.anthropic.com' },
      fetchImpl,
    );
    expect(claude.items.map((item) => item.id)).toEqual(['claude-sonnet', 'claude-haiku']);
    expect(calls.some((call) => call.apiKey === 'claude-key')).toBe(true);
    const called = calls.length;
    const manual = await listRemoteModels(kling, { accessKey: 'a', secretKey: 'b' }, fetchImpl);
    expect(calls.length).toBe(called);
    expect(manual.items).toEqual([]);
    expect(manual.unavailableReason).toMatch(/模型 ID/);
    await expect(
      listRemoteModels(deepseek, credentials, async () => new Response('no', { status: 401 })),
    ).rejects.toThrow(/401/);
  });
});
