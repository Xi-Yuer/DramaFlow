'use client';

import { useContext } from 'react';
import type { InputPortDefinition, StaticInputBinding } from '@dramaflow/contracts';
import { CandidateInputSummary } from '../inputs/candidate-input-summary';
import { availableStringOutputs } from '../inputs/template-input';
import { TemplateInputEditor } from '../inputs/template-input-editor';
import { WorkflowInputContext } from '../inputs/workflow-input-context';

export function NodeInputBindingField({
  nodeId,
  port,
  binding,
  rows = 4,
}: {
  nodeId: string;
  port: InputPortDefinition;
  binding: StaticInputBinding | undefined;
  rows?: number;
}) {
  const inputActions = useContext(WorkflowInputContext);
  if (!inputActions) return null;

  if (binding?.type === 'candidate') {
    return (
      <CandidateInputSummary
        portName={port.name}
        binding={binding}
        definition={inputActions.definition}
        manifests={inputActions.manifests}
      />
    );
  }

  const connected = inputActions.definition.edges.some(
    (edge) =>
      edge.kind === 'data' && edge.target.nodeId === nodeId && edge.target.portKey === port.key,
  );

  return (
    <TemplateInputEditor
      portName={port.name}
      rows={rows}
      binding={binding}
      connected={connected}
      outputs={availableStringOutputs(inputActions.definition, nodeId, inputActions.manifests)}
      definition={inputActions.definition}
      manifests={inputActions.manifests}
      disabled={inputActions.disabled}
      onChange={(next) => inputActions.onReplaceInput(nodeId, port.key, next)}
    />
  );
}
