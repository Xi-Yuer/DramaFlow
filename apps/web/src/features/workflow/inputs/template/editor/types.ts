import type {
  NodeTypeManifest,
  StaticInputBinding,
  WorkflowDefinition,
} from '@dramaflow/contracts';
import type { AvailableOutput, NodeOutputVariables } from '../types';

export interface TemplateInputProps {
  portName: string;
  rows: number;
  binding: StaticInputBinding | undefined;
  outputs: readonly AvailableOutput[];
  definition: Pick<WorkflowDefinition, 'nodes'>;
  manifests: readonly NodeTypeManifest[];
  disabled: boolean;
  onChange: (binding: StaticInputBinding | null) => void;
}

export interface TemplateEditorDraft {
  signature: string;
  text: string;
  variables: NodeOutputVariables;
}
