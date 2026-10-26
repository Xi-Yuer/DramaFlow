'use client';
import { createContext } from 'react';

export interface ModelSelectionIntent {
  nodeId: string;
  catalogId: string;
  displayName: string;
  providerDefinitionId: string;
  capability: string;
}

export interface ModelSelectionResume extends ModelSelectionIntent {
  providerId: string;
  resumedAt: number;
}

export interface WorkflowModelActions {
  projectId: string;
  disabled: boolean;
  onSelectModel: (nodeId: string, modelConfigurationId: string) => void;
  onOpenProvider: (
    providerDefinitionId: string,
    mode: 'configure' | 'manage',
    intent?: ModelSelectionIntent,
  ) => void;
  resume: ModelSelectionResume | null;
  onResumeConsumed: () => void;
}

export const WorkflowModelActionsContext = createContext<WorkflowModelActions | null>(null);

export interface ModelSelectorProps {
  nodeId: string;
  capabilityTypes: readonly string[];
  value: unknown;
}
