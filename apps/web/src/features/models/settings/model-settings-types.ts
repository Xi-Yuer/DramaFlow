import type { ModelProvider, ProviderCatalogItem } from '@dramaflow/contracts';

export type ModelSettingsProps = {
  open: boolean;
  setupRequest?: {
    definitionId: string;
    mode: 'configure' | 'manage';
    intent?: { providerDefinitionId: string } | null;
  } | null;
  onIntentCancelled?: () => void;
  onIntentProviderReady?: (provider: ModelProvider) => void;
  onClose: () => void;
};
export type ModelSettingsContentProps = {
  userId: string;
  setupRequest: {
    definitionId: string;
    mode: 'configure' | 'manage';
    intent?: { providerDefinitionId: string } | null;
  } | null;
  onIntentCancelled?: () => void;
  onIntentProviderReady?: (provider: ModelProvider) => void;
};
export type FormState =
  | { kind: 'configure'; definitionId: string }
  | { kind: 'manage'; definitionId: string }
  | { kind: 'advanced' }
  | { kind: 'model'; providerId?: string }
  | {
      kind: 'rotate';
      provider: ModelProvider;
      fields: ProviderCatalogItem['credentialFields'];
    };
