'use client';
import { useMemo, useState, type ContextType } from 'react';
import type {
  NodeTypeManifest,
  WorkflowDefinition,
  WorkflowOutputSource,
} from '@dramaflow/contracts';
import type { XYPosition } from '@xyflow/react';
import { WorkflowInputDialog } from '../../inputs/workflow-input-dialog';
import { projectBodyInputBoundary } from '../../iteration/body-input-boundary';
import { WorkflowOutputActions, WorkflowOutputDialog } from '../../outputs/workflow-end';
import { WorkflowOutputTargetDialog } from '../../outputs/workflow-output-target-dialog';
import {
  addWorkflowOutput,
  setWorkflowOutput,
  removeWorkflowOutput,
  appendWorkflowOutputCandidate,
  removeWorkflowOutputCandidate,
  projectWorkflowEnd,
} from '../../outputs/workflow-outputs';
import type { WorkflowCanvasProps } from '../view/canvas-types';

export function useCanvasBoundaries({
  workflow,
  manifests,
  locked,
  atRoot,
  catalogUnavailable,
  onEdit,
}: {
  workflow: WorkflowDefinition;
  manifests: readonly NodeTypeManifest[];
  locked: boolean;
  atRoot: boolean;
  catalogUnavailable: boolean;
  onEdit: WorkflowCanvasProps['onEdit'];
}) {
  const [endPosition, setEndPosition] = useState<XYPosition>(
    () => projectWorkflowEnd(workflow).node.position,
  );
  const [inputPosition, setInputPosition] = useState<XYPosition>(
    () => projectBodyInputBoundary(workflow).node.position,
  );
  const [inputEditorOpen, setInputEditorOpen] = useState(false);
  const inputBoundary = useMemo(
    () =>
      projectBodyInputBoundary(workflow, inputPosition, {
        scope: atRoot ? 'root' : 'body',
        disabled: locked,
        onConfigure: atRoot ? () => setInputEditorOpen(true) : undefined,
      }),
    [inputPosition, atRoot, locked, workflow],
  );
  const [outputEditor, setOutputEditor] = useState<{ name?: string } | null>(null);
  const [pendingOutputSource, setPendingOutputSource] = useState<WorkflowOutputSource | null>(null);
  const end = useMemo(() => projectWorkflowEnd(workflow, endPosition), [workflow, endPosition]);

  const outputActions: NonNullable<ContextType<typeof WorkflowOutputActions>> = {
    disabled: locked,
    onConfigure: (name) => setOutputEditor(name === undefined ? {} : { name }),
    onRemove: (name) => {
      if (!locked) onEdit((current) => removeWorkflowOutput(current, name));
    },
    onRemoveCandidate: (name, source) => {
      if (!locked) onEdit((current) => removeWorkflowOutputCandidate(current, name, source));
    },
  };

  function setBoundaryPosition(id: string, position: XYPosition) {
    if (id === end.node.id) setEndPosition(position);
    if (id === inputBoundary.node.id) setInputPosition(position);
  }

  function requestOutputSource(source: WorkflowOutputSource) {
    if (workflow.outputs.length) setPendingOutputSource(source);
    else onEdit((current) => addWorkflowOutput(current, source, manifests));
  }

  const dialogs = (
    <>
      {atRoot && inputEditorOpen ? (
        <WorkflowInputDialog
          definition={workflow}
          manifests={manifests}
          disabled={locked || catalogUnavailable}
          onEdit={onEdit}
          onClose={() => setInputEditorOpen(false)}
        />
      ) : null}
      {pendingOutputSource ? (
        <WorkflowOutputTargetDialog
          outputs={workflow.outputs}
          disabled={locked || catalogUnavailable}
          onCancel={() => setPendingOutputSource(null)}
          onCreate={() => {
            if (locked) return;
            onEdit((current) => addWorkflowOutput(current, pendingOutputSource, manifests));
            setPendingOutputSource(null);
          }}
          onAppend={(name) => {
            if (locked) return;
            onEdit((current) =>
              appendWorkflowOutputCandidate(current, name, pendingOutputSource, manifests),
            );
            setPendingOutputSource(null);
          }}
        />
      ) : null}
      {outputEditor && (
        <WorkflowOutputDialog
          definition={workflow}
          manifests={manifests}
          previousName={outputEditor.name}
          disabled={locked || catalogUnavailable}
          onCancel={() => setOutputEditor(null)}
          onSave={(value) => {
            if (locked) return;
            onEdit((current) => setWorkflowOutput(current, value, manifests, outputEditor.name));
            setOutputEditor(null);
          }}
        />
      )}
    </>
  );
  return { end, inputBoundary, outputActions, setBoundaryPosition, requestOutputSource, dialogs };
}
