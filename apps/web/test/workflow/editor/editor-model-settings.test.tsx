// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ModelProvider } from '@dramaflow/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { useEditorModelSettings } from '../../../src/features/workflow/editor/models/use-editor-model-settings';

const intent = {
  providerDefinitionId: 'deepseek',
  catalogId: 'deepseek-chat',
  displayName: 'DeepSeek Chat',
  capability: 'text.generate',
  nodeId: 'generate',
};
const provider: ModelProvider = {
  id: '7ac10b00-33cc-4e50-9a2b-05ef764c44f4',
  ownerId: 'owner',
  name: '测试供应商',
  pluginId: 'test_provider',
  pluginVersion: 1,
  providerDefinitionId: intent.providerDefinitionId,
  configuration: {},
  enabled: true,
  createdAt: '2026-10-27T00:00:00.000Z',
};

afterEach(cleanup);

describe('编辑器模型设置意图', () => {
  it('仅在明确的供应商配置意图成功后恢复原选择', () => {
    const { result } = renderHook(useEditorModelSettings);
    act(() => result.current.openProvider(intent.providerDefinitionId, 'configure', intent));
    act(() => result.current.providerReady(provider));
    expect(result.current.modelSettingsOpen).toBe(false);
    expect(result.current.setupRequest).toBeNull();
    expect(result.current.modelResume).toMatchObject({ ...intent, providerId: provider.id });
    act(() => result.current.consumeResume());
    expect(result.current.modelResume).toBeNull();
  });

  it('取消配置意图后，供应商保存不再触发模型恢复', () => {
    const { result } = renderHook(useEditorModelSettings);
    act(() => result.current.openProvider(intent.providerDefinitionId, 'configure', intent));
    act(() => result.current.cancelIntent());
    act(() => result.current.providerReady(provider));
    expect(result.current.modelResume).toBeNull();
  });

  it('普通设置入口与其他供应商不会延续先前的选择意图', () => {
    const { result } = renderHook(useEditorModelSettings);
    act(() => result.current.openProvider(intent.providerDefinitionId, 'configure', intent));
    act(() =>
      result.current.providerReady({ ...provider, providerDefinitionId: 'another-provider' }),
    );
    expect(result.current.modelResume).toBeNull();
    act(() => result.current.openProvider(intent.providerDefinitionId, 'configure', intent));
    act(() => result.current.openSettings());
    act(() => result.current.providerReady(provider));
    expect(result.current.modelResume).toBeNull();
  });
});
