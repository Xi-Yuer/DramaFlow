'use client';
import type { ContextType, ReactNode } from 'react';
import type { NodeTypeManifest } from '@dramaflow/contracts';
import { WorkflowNodeSettingsActions } from '../../node-catalog/human-review-settings';
import { WorkflowModelActionsContext } from '../../model-selection/selection/model-selection-context';
import { WorkflowInputContext } from '../../inputs/workflow-input-context';
import { replaceNodeInput } from '../../inputs/template/binding';
import { WorkflowOutputActions } from '../../outputs/workflow-end';
import { WorkflowConditionActions } from '../../conditions/if-condition-editor';
import { setIfCondition } from '../../conditions/if-condition';
import { WorkflowManifestProvider, WorkflowNodeSelectionContext } from '../rendering/workflow-node';
import type { WorkflowCanvasProps } from '../view/canvas-types';

export function CanvasEditingProviders({
  children,
  projectId,
  workflow,
  manifests,
  locked,
  selectedNodeId,
  selectNode,
  onEdit,
  onOpenProvider,
  modelResume = null,
  onModelResumeConsumed,
  outputActions,
}: Pick<
  WorkflowCanvasProps,
  'projectId' | 'workflow' | 'onEdit' | 'onOpenProvider' | 'modelResume' | 'onModelResumeConsumed'
> & {
  children: ReactNode;
  manifests: readonly NodeTypeManifest[];
  locked: boolean;
  selectedNodeId: string | null;
  selectNode: (nodeId: string) => void;
  outputActions: NonNullable<ContextType<typeof WorkflowOutputActions>>;
}) {
  return (
    <WorkflowNodeSelectionContext.Provider
      value={{
        selectedNodeId: selectedNodeId,
        onSelectNode: (nodeId) => selectNode(nodeId),
      }}
    >
      <WorkflowNodeSettingsActions.Provider
        value={{
          disabled: locked,
          onRename: (nodeId, name) => {
            if (!locked && name.trim())
              onEdit((current) => ({
                ...current,
                nodes: current.nodes.map((node) =>
                  node.id === nodeId ? { ...node, name: name.trim() } : node,
                ),
              }));
          },
          onConfigChange: (nodeId, key, value) => {
            if (!locked)
              onEdit((current) => ({
                ...current,
                nodes: current.nodes.map((node) => {
                  if (node.id !== nodeId) return node;
                  const config = { ...node.config };
                  if (value === undefined) delete config[key];
                  else config[key] = value;
                  return { ...node, config };
                }),
              }));
          },
        }}
      >
        <WorkflowModelActionsContext.Provider
          value={{
            projectId,
            disabled: locked,
            onOpenProvider,
            resume: modelResume,
            onResumeConsumed: onModelResumeConsumed ?? (() => undefined),
            onSelectModel: (nodeId, modelConfigurationId) =>
              onEdit((current) => ({
                ...current,
                nodes: current.nodes.map((node) =>
                  node.id === nodeId
                    ? { ...node, config: { ...node.config, modelConfigurationId } }
                    : node,
                ),
              })),
          }}
        >
          <WorkflowInputContext.Provider
            value={{
              disabled: locked,
              definition: workflow,
              manifests: manifests,
              onReplaceInput: (nodeId, portKey, binding) =>
                onEdit((current) => replaceNodeInput(current, nodeId, portKey, binding)),
            }}
          >
            <WorkflowOutputActions.Provider value={outputActions}>
              <WorkflowConditionActions.Provider
                value={{
                  disabled: locked,
                  onChange: (nodeId, condition) => {
                    if (!locked) onEdit((current) => setIfCondition(current, nodeId, condition));
                  },
                }}
              >
                <WorkflowManifestProvider manifests={manifests}>
                  {children}
                </WorkflowManifestProvider>
              </WorkflowConditionActions.Provider>
            </WorkflowOutputActions.Provider>
          </WorkflowInputContext.Provider>
        </WorkflowModelActionsContext.Provider>
      </WorkflowNodeSettingsActions.Provider>
    </WorkflowNodeSelectionContext.Provider>
  );
}
