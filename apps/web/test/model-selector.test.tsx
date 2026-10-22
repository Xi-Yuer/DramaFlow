import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConfiguredModelGroup } from '../src/features/workflow/model-selector';

describe('Node Model Selector 已配置模型（静态组件测试）', () => {
  it('无 Catalog 的 custom configuration 按 Provider Instance 展示并保留选择 ID', () => {
    const html = renderToStaticMarkup(
      <ConfiguredModelGroup
        group={{
          providerId: 'provider-deepseek',
          providerName: 'DeepSeek',
          models: [
            {
              configurationId: 'configuration-deepseek',
              model: 'deepseek-flash',
              displayName: 'deepseek-flash',
              detail: null,
            },
          ],
        }}
        selectedId={undefined}
        onSelect={() => undefined}
      />,
    );
    expect(html).toContain('DeepSeek');
    expect(html).toContain('deepseek-flash');
    expect(html).toContain('data-configuration-id="configuration-deepseek"');
    expect(html).toContain('可用');
  });

  it('当前 modelConfigurationId 只标记对应配置为已选', () => {
    const html = renderToStaticMarkup(
      <ConfiguredModelGroup
        group={{
          providerId: 'provider-openai',
          providerName: 'OpenAI',
          models: [
            {
              configurationId: 'configuration-gpt',
              model: 'gpt-4o',
              displayName: 'GPT-4o',
              detail: '最大输出 128',
            },
          ],
        }}
        selectedId="configuration-gpt"
        onSelect={() => undefined}
      />,
    );
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('data-configuration-id="configuration-gpt"');
    expect(html).toContain('最大输出 128');
  });
});
