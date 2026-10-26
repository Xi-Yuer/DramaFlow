'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ReactFlowProvider, type OnMove } from '@xyflow/react';
import type { NodeRun, Project, WorkflowDefinition } from '@dramaflow/contracts';
import { WorkflowCanvas } from '@/features/workflow/canvas/workflow-canvas';
import type {
  ModelSelectionIntent,
  ModelSelectionResume,
} from '../model-selection/selection/model-selection-context';
import type { HumanReviewActions, WorkflowRunStatusState } from '../run/status/workflow-run-status';
import { clampViewport } from './viewport';
import {
  createGraphNavigation,
  currentGraphLocation,
  editLocatedGraph,
  enterNestedGraph,
  type GraphNavigationState,
  graphLocationKey,
  isIterationBodyAction,
  jumpToGraph,
  navigationCrumbs,
  patchGraphView,
  popGraph,
  readLocatedGraph,
  retreatToExistingGraph,
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
    if (location.length > 0 && !graph) commit((state) => retreatToExistingGraph(state, workflow));
  }, [commit, graph, location.length, workflow]);

  useImperativeHandle(
    ref,
    () => ({
      getRootViewport() {
        const state = navigationRef.current;
        if (currentGraphLocation(state).length === 0 && viewportControllerRef.current)
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
        if (currentGraphLocation(navigationRef.current).length === 0)
          viewportControllerRef.current?.setViewport(next);
      },
    }),
    [commit],
  );

  function withLiveViewport(state: GraphNavigationState) {
    const live = viewportControllerRef.current?.getViewport();
    return live
      ? patchGraphView(state, currentGraphLocation(state), { viewport: clampViewport(live) })
      : state;
  }

  function enter(ownerNodeId: string) {
    commit((state) => enterNestedGraph(withLiveViewport(state), workflow, ownerNodeId));
  }

  function leave(apply: (state: GraphNavigationState) => GraphNavigationState) {
    commit((state) => apply(withLiveViewport(state)));
  }

  if (!graph) return null;
  const atRoot = location.length === 0;
  const crumbs = navigationCrumbs(workflow, navigation);

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
            atRoot = current.length === 0;
            return patchGraphView(state, current, { viewport });
          });
          if (atRoot) onRootViewportChange(event, viewport);
        }}
        locationName={atRoot ? 'root' : location.at(-1)!.graphKey}
        manifestFilter={location.at(-1)?.graphKey === 'body' ? isIterationBodyAction : undefined}
        onEnterGraph={enter}
        navigation={
          atRoot
            ? null
            : {
                crumbs: crumbs.map((crumb, index) => ({
                  label: crumb.label,
                  current: index === crumbs.length - 1,
                  onSelect: () => leave((state) => jumpToGraph(state, index)),
                })),
                onBack: () => leave(popGraph),
              }
        }
        viewportControllerRef={viewportControllerRef}
        runStatus={atRoot ? runStatus : null}
        reviewActions={atRoot ? reviewActions : undefined}
        nodeRuns={atRoot ? nodeRuns : undefined}
        onRefreshRunStatus={atRoot ? onRefreshRunStatus : undefined}
      />
    </ReactFlowProvider>
  );
});
