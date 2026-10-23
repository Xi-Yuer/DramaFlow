// @vitest-environment happy-dom
import { App, ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ModelSelector,
  WorkflowModelActionsContext,
} from '../src/features/workflow/model-selection/model-selector';

const mocks = vi.hoisted(() => ({ userId: 'user-a', providers: vi.fn(), models: vi.fn() }));
vi.mock('../src/features/auth/use-identity', () => ({
  useIdentity: () => ({ data: { id: mocks.userId } }),
}));
vi.mock('../src/features/models/model-api', async (original) => {
  const actual = await original<typeof import('../src/features/models/model-api')>();
  return {
    ...actual,
    modelApi: {
      ...actual.modelApi,
      modelCatalog: async () => ({ items: [] }),
      providerCatalog: async () => ({ items: [] }),
      providers: mocks.providers,
      models: mocks.models,
    },
  };
});
const modelId = '00000000-0000-4000-8000-000000000031';
const provider = {
  id: '00000000-0000-4000-8000-000000000021',
  ownerId: 'user-a',
  name: 'DeepSeek',
  pluginId: 'openai_compatible',
  pluginVersion: 1,
  providerDefinitionId: null,
  configuration: {},
  enabled: true,
  createdAt: '2026-10-23T00:00:00.000Z',
};
const configuration = {
  id: modelId,
  ownerId: 'user-a',
  providerId: provider.id,
  capability: 'text.generate',
  model: 'deepseek-chat',
  settings: {},
  enabled: true,
  createdAt: provider.createdAt,
  availability: { selectable: true, unavailableReason: null },
};
beforeEach(() => {
  mocks.userId = 'user-a';
  vi.clearAllMocks();
  mocks.providers.mockImplementation(async () => (mocks.userId === 'user-a' ? [provider] : []));
  mocks.models.mockImplementation(async () => (mocks.userId === 'user-a' ? [configuration] : []));
});
afterEach(cleanup);

function selector(client: QueryClient, projectId: string, onSelectModel = vi.fn()) {
  return render(
    <QueryClientProvider client={client}>
      <ConfigProvider theme={{ token: { motion: false } }}>
        <App>
          <WorkflowModelActionsContext.Provider
            value={{
              projectId,
              disabled: false,
              onSelectModel,
              onOpenProvider: vi.fn(),
              resume: null,
              onResumeConsumed: vi.fn(),
            }}
          >
            <ModelSelector nodeId="text-a" capabilityTypes={['text.generate']} value={undefined} />
          </WorkflowModelActionsContext.Provider>
        </App>
      </ConfigProvider>
    </QueryClientProvider>,
  );
}

describe('用户模型在多个 Project 的真实选择器行为', () => {
  it('A / B / 新 Project C 都可以选择同一个已有 DeepSeek configuration ID', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (const projectId of ['project-a', 'project-b', 'new-project-c']) {
      const onSelect = vi.fn();
      const view = selector(client, projectId, onSelect);
      fireEvent.click(screen.getByRole('button', { name: '选择模型' }));
      fireEvent.click(await screen.findByRole('option', { name: /deepseek-chat/ }));
      expect(onSelect).toHaveBeenCalledWith('text-a', modelId);
      view.unmount();
    }
    expect(mocks.models).toHaveBeenCalledTimes(3);
    expect(mocks.models.mock.calls.every(([signal]) => signal instanceof AbortSignal)).toBe(true);
  });
  it('同一 QueryClient 切换到 B 用户也不会复用 A 的模型缓存', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = selector(client, 'project-a');
    fireEvent.click(screen.getByRole('button', { name: '选择模型' }));
    expect(await screen.findByRole('option', { name: /deepseek-chat/ })).toBeTruthy();
    first.unmount();
    mocks.userId = 'user-b';
    selector(client, 'project-b');
    fireEvent.click(screen.getByRole('button', { name: '选择模型' }));
    await waitFor(() => expect(mocks.models).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('option', { name: /deepseek-chat/ })).toBeNull();
  });
});
