import type { NodeRun, NodeTypeManifest, Project, WorkflowDefinition } from '@dramaflow/contracts';
import type { OnMove } from '@xyflow/react';
import type { ReactNode } from 'react';
import type {
  ModelSelectionIntent,
  ModelSelectionResume,
} from '../../model-selection/selection/model-selection-context';
import type {
  HumanReviewActions,
  WorkflowRunStatusState,
} from '../../run/status/workflow-run-status';
import type { GraphViewportController } from '../../editor/navigation/graph-navigation';
import type { WorkflowBodyInputNode } from '../../iteration/body-input-boundary';
import type { WorkflowEndNode, WorkflowOutputEdge } from '../../outputs/workflow-outputs';
import type { WorkflowNode, WorkflowEdge } from '../adapter/types';
import type { GraphExecutionProjection } from '../../runtime/projection/graph-execution-projection';

export type CanvasNode = WorkflowNode | WorkflowEndNode | WorkflowBodyInputNode;
export type CanvasEdge = WorkflowEdge | WorkflowOutputEdge;

export type WorkflowCanvasProps = {
  projectId: string;
  workflow: WorkflowDefinition;
  onEdit: (apply: (current: WorkflowDefinition) => WorkflowDefinition) => void;
  onOpenProvider: (
    providerDefinitionId: string,
    mode: 'configure' | 'manage',
    intent?: ModelSelectionIntent,
  ) => void;
  modelResume?: ModelSelectionResume | null;
  onModelResumeConsumed?: () => void;
  reloading: boolean;
  interactionLocked?: boolean;
  defaultViewport: Project['viewport'];
  onMoveEnd: OnMove;
  initialSelectedNodeId?: string | null;
  initialSelectedEdgeIds?: readonly string[];
  onSelectionChange?: (selection: {
    selectedNodeId: string | null;
    selectedEdgeIds: readonly string[];
  }) => void;
  manifestFilter?: (manifest: NodeTypeManifest) => boolean;
  locationName?: 'root' | 'body' | 'graph';
  onEnterGraph?: (ownerNodeId: string) => void;
  navigation?: {
    crumbs: readonly { label: string; current: boolean; onSelect: () => void }[];
    onBack: () => void;
  } | null;
  viewportControllerRef?: { current: GraphViewportController | null };
  runStatus?: WorkflowRunStatusState | null;
  reviewActions?: HumanReviewActions;
  nodeRuns?: readonly NodeRun[];
  projection?: GraphExecutionProjection;
  executionContext?: ReactNode;
  onRefreshRunStatus?: () => void;
};
