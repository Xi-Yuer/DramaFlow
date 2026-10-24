'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ReactFlowProvider, type OnMove } from '@xyflow/react';
import type { NodeRun, Project, WorkflowDefinition } from '@dramaflow/contracts';
import { WorkflowCanvas } from '@/features/workflow/canvas/workflow-canvas';
import type {
  ModelSelectionIntent,
  ModelSelectionResume,
} from '@/features/workflow/model-selection/model-selector';
import type { HumanReviewActions, WorkflowRunStatusState } from '../run/status/workflow-run-status';
import { clampViewport } from './viewport';
import {
  canEnterIterationBody,
  createGraphNavigation,
  currentGraphLocation,
  editLocatedGraph,
  type GraphNavigationState,
  enterIterationBody,
  exitToRoot,
  graphLocationKey,
  isIterationBodyAction,
  patchGraphView,
  readLocatedGraph,
  rootGraphLocation,
  type GraphViewport,
  type GraphViewportController,
} from './graph-navigation';

export interface GraphCanvasSessionHandle {
  getRootViewport: () => GraphViewport;
  setRootViewport: (viewport: GraphViewport) => void;
}

export const GraphCanvasSession = forwardRef<
  GraphCanvasSessionHandle,
  {
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
    initialRootViewport: Project['viewport'];
    onRootViewportChange: OnMove;
    runStatus?: WorkflowRunStatusState | null;
    reviewActions?: HumanReviewActions;
    nodeRuns?: readonly NodeRun[];
    onRefreshRunStatus?: () => void;
  }
>(function GraphCanvasSession(
  {
    projectId,
    workflow,
    onEdit,
    onOpenProvider,
    modelResume = null,
    onModelResumeConsumed,
    reloading,
    interactionLocked = false,
    initialRootViewport,
    onRootViewportChange,
    runStatus = null,
    reviewActions,
    nodeRuns,
    onRefreshRunStatus,
  },
  ref,
) {
  const [navigation, setNavigation] = useState(() => createGraphNavigation(initialRootViewport));
  const navigationRef = useRef(navigation);
  const viewportControllerRef = useRef<GraphViewportController | null>(null);
  const location = currentGraphLocation(navigation);
  const locationRef = useRef(location);
  const commit = useCallback((recipe: (state: GraphNavigationState) => GraphNavigationState) => {
    setNavigation((state) => {
      const next = recipe(state);
      navigationRef.current = next;
      locationRef.current = currentGraphLocation(next);
      return next;
    });
  }, []);
  useEffect(() => {
    navigationRef.current = navigation;
    locationRef.current = location;
  });
  const view = navigation.views[graphLocationKey(location)] ?? {
    selectedNodeId: null,
    selectedEdgeIds: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const graph = readLocatedGraph(workflow, location);

  useEffect(() => {
    if (location.kind === 'nested' && !graph) commit((state) => exitToRoot(state));
  }, [commit, graph, location]);

  useImperativeHandle(
    ref,
    () => ({
      getRootViewport() {
        const state = navigationRef.current;
        if (currentGraphLocation(state).kind === 'root' && viewportControllerRef.current)
          return clampViewport(viewportControllerRef.current.getViewport());
        return (
          state.views[graphLocationKey(rootGraphLocation)]?.viewport ?? {
            x: 0,
            y: 0,
            zoom: 1,
          }
        );
      },
      setRootViewport(viewport) {
        const next = clampViewport(viewport);
        commit((state) => patchGraphView(state, rootGraphLocation, { viewport: next }));
        if (currentGraphLocation(navigationRef.current).kind === 'root')
          viewportControllerRef.current?.setViewport(next);
      },
    }),
    [commit],
  );

  function enter(ownerNodeId: string) {
    const owner = workflow.nodes.find((node) => node.id === ownerNodeId);
    if (!canEnterIterationBody(owner)) return;
    const live = viewportControllerRef.current?.getViewport();
    commit((state) => {
      const withViewport = live
        ? patchGraphView(state, rootGraphLocation, { viewport: clampViewport(live) })
        : state;
      return enterIterationBody(withViewport, ownerNodeId);
    });
  }

  function backToRoot() {
    const live = viewportControllerRef.current?.getViewport();
    commit((state) => {
      const current = currentGraphLocation(state);
      const withViewport = live
        ? patchGraphView(state, current, { viewport: clampViewport(live) })
        : state;
      return exitToRoot(withViewport);
    });
  }

  if (!graph) return null;
  const atRoot = location.kind === 'root';
  const owner = atRoot ? null : workflow.nodes.find((node) => node.id === location.ownerNodeId);

  return (
    <ReactFlowProvider key={graphLocationKey(location)}>
      <WorkflowCanvas
        projectId={projectId}
        workflow={graph}
        onEdit={(apply) =>
          onEdit((current) => editLocatedGraph(current, locationRef.current, apply))
        }
        onOpenProvider={onOpenProvider}
        modelResume={atRoot ? modelResume : null}
        onModelResumeConsumed={onModelResumeConsumed}
        reloading={reloading}
        interactionLocked={interactionLocked}
        defaultViewport={view.viewport}
        initialSelectedNodeId={view.selectedNodeId}
        initialSelectedEdgeIds={view.selectedEdgeIds}
        onSelectionChange={(selection) =>
          commit((state) => patchGraphView(state, currentGraphLocation(state), selection))
        }
        onMoveEnd={(event, next) => {
          const viewport = clampViewport(next);
          let atRoot = false;
          commit((state) => {
            const current = currentGraphLocation(state);
            atRoot = current.kind === 'root';
            return patchGraphView(state, current, { viewport });
          });
          if (atRoot) onRootViewportChange(event, viewport);
        }}
        manifestFilter={atRoot ? undefined : isIterationBodyAction}
        onEnterBody={atRoot ? enter : undefined}
        navigation={atRoot || !owner ? null : { ownerName: owner.name, onBackToRoot: backToRoot }}
        viewportControllerRef={viewportControllerRef}
        runStatus={atRoot ? runStatus : null}
        reviewActions={atRoot ? reviewActions : undefined}
        nodeRuns={atRoot ? nodeRuns : undefined}
        onRefreshRunStatus={atRoot ? onRefreshRunStatus : undefined}
      />
    </ReactFlowProvider>
  );
});
