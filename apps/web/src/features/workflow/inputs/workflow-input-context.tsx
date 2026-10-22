'use client';

import { createContext } from 'react';
import type {
  NodeTypeManifest,
  StaticInputBinding,
  WorkflowDefinition,
} from '@dramaflow/contracts';

export interface WorkflowInputActions {
  disabled: boolean;
  definition: WorkflowDefinition;
  manifests: readonly NodeTypeManifest[];
  onReplaceInput: (nodeId: string, portKey: string, binding: StaticInputBinding | null) => void;
}

export const WorkflowInputContext = createContext<WorkflowInputActions | null>(null);
