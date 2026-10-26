// @vitest-environment happy-dom
import { App, ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedModelConfiguration,
  ModelProvider,
  ProviderCatalogItem,
} from '@dramaflow/contracts';
import { modelApi } from '../src/features/models/model-api';
import { ModelSettings } from '../src/features/models/model-settings';
import { CredentialRotationForm } from '../src/features/models/providers/credential-rotation-form';
import { ModelSelector } from '../src/features/workflow/model-selection/model-selector';
import { WorkflowModelActionsContext } from '../src/features/workflow/model-selection/selection/model-selection-context';

vi.mock('../src/features/auth/use-identity', () => ({
  useIdentity: () => ({ data: { id: 'model-settings-user' } }),
}));

const definition: ProviderCatalogItem = {
  id: 'demo',
  displayName: '演示供应商',
  available: true,
  capabilities: [{ type: 'text.generate', name: '文本生成' }],
  credentialFields: [{ key: 'apiKey', required: true, minLength: 1 }],
  configurationSchema: { type: 'object', properties: {}, additionalProperties: false },
};
const provider: ModelProvider = {
  id: '00000000-0000-4000-8000-000000000021',
  ownerId: 'model-settings-user',
  name: '演示供应商',
  pluginId: 'demo',
  pluginVersion: 1,
  providerDefinitionId: 'demo',
  configuration: {},
  enabled: true,
  createdAt: '2026-10-26T00:00:00.000Z',
};
let client: QueryClient;
function renderWithProviders(element: ReactNode) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <QueryClientProvider client={client}>{element}</QueryClientProvider>
      </App>
    </ConfigProvider>,
  );
}
beforeEach(() => {
  vi.spyOn(modelApi, 'catalog').mockResolvedValue({ items: [] });
  vi.spyOn(modelApi, 'providerCatalog').mockResolvedValue({ items: [definition] });
  vi.spyOn(modelApi, 'modelCatalog').mockResolvedValue({ items: [] });
  vi.spyOn(modelApi, 'providers').mockResolvedValue([]);
  vi.spyOn(modelApi, 'models').mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
});

describe('模型设置拆分后的提交与会话边界', () => {
  it('凭证提交即清空，进行中不能重复提交，失败不回填或自动重试', async () => {
    let reject: (error: Error) => void = () => {
      throw new Error('尚未提交');
    };
    const create = vi.spyOn(modelApi, 'createCatalogProvider').mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const ready = vi.fn();
    renderWithProviders(
      <ModelSettings
        open
        onClose={() => undefined}
        setupRequest={{
          definitionId: 'demo',
          mode: 'configure',
          intent: { providerDefinitionId: 'demo' },
        }}
        onIntentProviderReady={ready}
      />,
    );
    const secret = await screen.findByLabelText('API Key');
    fireEvent.change(secret, { target: { value: 'test-only-credential' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 API Key' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(secret).toHaveProperty('value', '');
    fireEvent.click(screen.getByRole('button', { name: '保存 API Key' }));
    expect(create).toHaveBeenCalledOnce();
    await act(async () => reject(new Error('保存失败')));
    await screen.findByText(/凭证已清空，请刷新列表核对后再提交/);
    expect(secret).toHaveProperty('value', '');
    expect(ready).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain('test-only-credential');
  });

  it('目录供应商创建成功后只恢复明确的配置意图', async () => {
    vi.spyOn(modelApi, 'createCatalogProvider').mockResolvedValue(provider);
    const ready = vi.fn();
    renderWithProviders(
      <ModelSettings
        open
        onClose={() => undefined}
        setupRequest={{
          definitionId: 'demo',
          mode: 'configure',
          intent: { providerDefinitionId: 'demo' },
        }}
        onIntentProviderReady={ready}
      />,
    );
    fireEvent.change(await screen.findByLabelText('API Key'), {
      target: { value: 'test-only-credential' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存 API Key' }));
    await waitFor(() => expect(ready).toHaveBeenCalledExactlyOnceWith(provider));
    expect(modelApi.createCatalogProvider).toHaveBeenCalledExactlyOnceWith({
      name: '演示供应商',
      providerDefinitionId: 'demo',
      credentials: { apiKey: 'test-only-credential' },
    });
  });

  it('取消配置清除当前表单并通知原选择意图，不重新打开配置', async () => {
    const cancelled = vi.fn();
    renderWithProviders(
      <ModelSettings
        open
        onClose={() => undefined}
        setupRequest={{
          definitionId: 'demo',
          mode: 'configure',
          intent: { providerDefinitionId: 'demo' },
        }}
        onIntentCancelled={cancelled}
      />,
    );
    const dialog = (await screen.findByLabelText('API Key')).closest<HTMLElement>(
      '[role="dialog"]',
    )!;
    fireEvent.click(within(dialog).getByRole('button', { name: '返回列表' }));
    await waitFor(() => expect(screen.queryByLabelText('API Key')).toBeNull());
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('管理供应商可转入凭证轮换，关闭时不隐式提交', async () => {
    vi.mocked(modelApi.providers).mockResolvedValue([provider]);
    const rotate = vi.spyOn(modelApi, 'replaceCredentials');
    renderWithProviders(
      <ModelSettings
        open
        onClose={() => undefined}
        setupRequest={{ definitionId: 'demo', mode: 'manage' }}
      />,
    );
    const dialog = (await screen.findByText('管理 演示供应商')).closest<HTMLElement>(
      '[role="dialog"]',
    )!;
    fireEvent.click(within(dialog).getByRole('button', { name: '轮换凭证' }));
    const rotation = (await screen.findByLabelText('API Key')).closest<HTMLElement>(
      '[role="dialog"]',
    )!;
    fireEvent.change(within(rotation).getByLabelText('API Key'), {
      target: { value: 'test-only-credential' },
    });
    fireEvent.click(within(rotation).getByRole('button', { name: '返回列表' }));
    await waitFor(() => expect(screen.queryByLabelText('API Key')).toBeNull());
    expect(rotate).not.toHaveBeenCalled();
  });

  it('凭证轮换失败后清空输入，保留原供应商与模型身份', async () => {
    const rotate = vi
      .spyOn(modelApi, 'replaceCredentials')
      .mockRejectedValue(new Error('轮换失败'));
    const rotated = vi.fn();
    renderWithProviders(
      <CredentialRotationForm
        provider={provider}
        fields={definition.credentialFields}
        onClose={() => undefined}
        onRotated={rotated}
      />,
    );
    const secret = screen.getByLabelText('API Key');
    fireEvent.change(secret, { target: { value: 'test-only-credential' } });
    fireEvent.click(screen.getByRole('button', { name: '确认轮换' }));
    await screen.findByText(/输入已清空，请重新输入需要保存的完整凭证/);
    expect(secret).toHaveProperty('value', '');
    expect(rotate).toHaveBeenCalledExactlyOnceWith(provider.id, { apiKey: 'test-only-credential' });
    expect(rotated).not.toHaveBeenCalled();
  });

  it.each([1, 2])('配置恢复读取到 %s 个可用配置，保持原有明确选择规则', async (count) => {
    const configurations: ManagedModelConfiguration[] = Array.from(
      { length: count },
      (_, index) => ({
        id: `00000000-0000-4000-8000-00000000003${index}`,
        ownerId: provider.ownerId,
        providerId: provider.id,
        capability: 'text.generate',
        model: 'demo-model',
        settings: { maxOutputTokens: 100 + index },
        enabled: true,
        createdAt: provider.createdAt,
        availability: { selectable: true, unavailableReason: null },
      }),
    );
    vi.mocked(modelApi.providers).mockResolvedValue([provider]);
    vi.mocked(modelApi.models).mockResolvedValue(configurations);
    const select = vi.fn();
    const consumed = vi.fn();
    renderWithProviders(
      <WorkflowModelActionsContext.Provider
        value={{
          projectId: 'project',
          disabled: false,
          onOpenProvider: vi.fn(),
          onSelectModel: select,
          onResumeConsumed: consumed,
          resume: {
            nodeId: 'generate',
            catalogId: 'demo-model',
            displayName: 'demo-model',
            providerDefinitionId: 'demo',
            providerId: provider.id,
            capability: 'text.generate',
            resumedAt: 0,
          },
        }}
      >
        <ModelSelector nodeId="generate" capabilityTypes={['text.generate']} value={undefined} />
      </WorkflowModelActionsContext.Provider>,
    );
    await waitFor(() => expect(consumed).toHaveBeenCalledOnce());
    if (count === 1) {
      expect(select).toHaveBeenCalledExactlyOnceWith('generate', configurations[0]!.id);
    } else {
      expect(select).not.toHaveBeenCalled();
      const choices = within(await screen.findByRole('dialog', { name: '选择模型' })).getAllByRole(
        'option',
      );
      expect(choices).toHaveLength(2);
      fireEvent.click(choices[1]!);
      expect(select).toHaveBeenCalledExactlyOnceWith('generate', configurations[1]!.id);
    }
  });
});
