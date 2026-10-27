import { useState } from 'react';
import type { ModelProvider } from '@dramaflow/contracts';
import type {
  ModelSelectionIntent,
  ModelSelectionResume,
} from '../../model-selection/selection/model-selection-context';

export function useEditorModelSettings() {
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [setupRequest, setSetupRequest] = useState<{
    definitionId: string;
    mode: 'configure' | 'manage';
    intent: ModelSelectionIntent | null;
  } | null>(null);
  const [modelResume, setModelResume] = useState<ModelSelectionResume | null>(null);

  function openSettings() {
    setSetupRequest(null);
    setModelSettingsOpen(true);
  }

  function openProvider(
    definitionId: string,
    mode: 'configure' | 'manage',
    intent?: ModelSelectionIntent,
  ) {
    setSetupRequest({ definitionId, mode, intent: intent ?? null });
    setModelSettingsOpen(true);
  }

  function cancelIntent() {
    setSetupRequest((current) => (current ? { ...current, intent: null } : null));
  }

  function providerReady(provider: ModelProvider) {
    const intent = setupRequest?.intent;
    setModelSettingsOpen(false);
    setSetupRequest(null);
    if (intent && provider.providerDefinitionId === intent.providerDefinitionId) {
      setModelResume({ ...intent, providerId: provider.id, resumedAt: Date.now() });
    }
  }

  function closeSettings() {
    setModelSettingsOpen(false);
    setSetupRequest(null);
  }

  return {
    modelSettingsOpen,
    setupRequest,
    modelResume,
    openSettings,
    openProvider,
    cancelIntent,
    providerReady,
    closeSettings,
    consumeResume: () => setModelResume(null),
  };
}
