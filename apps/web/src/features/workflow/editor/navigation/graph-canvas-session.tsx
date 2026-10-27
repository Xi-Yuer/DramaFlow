'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { motion } from 'motion/react';
import { ReactFlowProvider, type OnMove } from '@xyflow/react';
import type { NodeRun, Project, WorkflowDefinition } from '@dramaflow/contracts';
import { WorkflowCanvas } from '@/features/workflow/canvas/workflow-canvas';
import type {
  ModelSelectionIntent,
  ModelSelectionResume,
} from '../../model-selection/selection/model-selection-context';
import type {
  HumanReviewActions,
  WorkflowRunStatusState,
} from '../../run/status/workflow-run-status';
import {
  DRILL_MOTION_MS,
  type DrillAnchor,
  type DrillTransition,
  captureDrillAnchor,
  completeDrill,
  decideDrill,
  drillPose,
  prefersReducedMotion,
} from './graph-drill-transition';
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

const DRILL_REST = { x: 0, y: 0, scale: 1, opacity: 1 };
const DRILL_TWEEN = {
  duration: DRILL_MOTION_MS / 1000,
  ease: [0.2, 0.8, 0.2, 1] as [number, number, number, number],
};

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
  const [drill, setDrill] = useState<DrillTransition | null>(null);
  const navigationRef = useRef(navigation);
  const drillRef = useRef<DrillTransition | null>(null);
  const pendingLeaveRef = useRef<GraphNavigationState | null>(null);
  const anchorsRef = useRef(new Map<string, DrillAnchor>());
  const drillTokenRef = useRef(0);
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
  const finishDrill = useCallback(
    (token: number) => {
      if (token !== drillTokenRef.current) return;
      const current = drillRef.current;
      drillTokenRef.current += 1;
      const pending = pendingLeaveRef.current;
      pendingLeaveRef.current = null;
      drillRef.current = null;
      setDrill(null);
      if (pending && completeDrill(current)) commit(() => pending);
    },
    [commit],
  );
  useEffect(() => {
    navigationRef.current = navigation;
    locationRef.current = location;
    drillRef.current = drill;
  });
  useEffect(() => {
    if (!drill) return;
    const token = drillTokenRef.current;
    const delay = drillPose(drill.anchor) ? DRILL_MOTION_MS + 40 : 0;
    const timer = window.setTimeout(() => finishDrill(token), delay);
    return () => window.clearTimeout(timer);
  }, [drill, finishDrill]);
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

  function measureOwner(nodeId: string): DrillAnchor | null {
    const node = document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
    const stage = node?.closest('.canvas-stage') ?? document.querySelector('.canvas-stage');
    return captureDrillAnchor(node, stage);
  }

  function stageSize(anchor: DrillAnchor | null) {
    const stage = document.querySelector('.canvas-stage');
    const rect = stage?.getBoundingClientRect();
    return {
      stageWidth: rect?.width || anchor?.stageWidth || 0,
      stageHeight: rect?.height || anchor?.stageHeight || 0,
    };
  }

  function startDrill(transition: DrillTransition, pending: GraphNavigationState | null) {
    const token = drillTokenRef.current + 1;
    drillTokenRef.current = token;
    pendingLeaveRef.current = pending;
    drillRef.current = transition;
    setDrill(transition);
  }

  function enter(ownerNodeId: string) {
    if (drillRef.current) return;
    const current = withLiveViewport(navigationRef.current);
    const next = enterNestedGraph(current, workflow, ownerNodeId);
    const fromKey = graphLocationKey(currentGraphLocation(current));
    const toKey = graphLocationKey(currentGraphLocation(next));
    const anchor = measureOwner(ownerNodeId);
    if (anchor) anchorsRef.current.set(toKey, anchor);
    const stage = stageSize(anchor);
    const decision = decideDrill({
      busy: false,
      reducedMotion: prefersReducedMotion(),
      anchor,
      ...stage,
      direction: 'enter',
      fromKey,
      toKey,
    });
    if (!decision.navigate && !decision.transition) return;
    if (decision.navigate) commit(() => next);
    if (decision.transition) startDrill(decision.transition, null);
  }

  function leave(apply: (state: GraphNavigationState) => GraphNavigationState) {
    if (drillRef.current) return;
    const current = withLiveViewport(navigationRef.current);
    const next = apply(current);
    const fromKey = graphLocationKey(currentGraphLocation(current));
    const toKey = graphLocationKey(currentGraphLocation(next));
    const anchor = anchorsRef.current.get(fromKey) ?? null;
    const stage = stageSize(anchor);
    const decision = decideDrill({
      busy: false,
      reducedMotion: prefersReducedMotion(),
      anchor,
      ...stage,
      direction: 'exit',
      fromKey,
      toKey,
    });
    if (!decision.navigate && !decision.transition) return;
    if (decision.transition) {
      startDrill(decision.transition, next);
      return;
    }
    if (decision.navigate) commit(() => next);
  }

  const atRoot = location.length === 0;
  const crumbs = navigationCrumbs(workflow, navigation);
  const enterPose = useMemo(() => {
    if (drill?.direction !== 'enter') return null;
    const pose = drillPose(drill.anchor);
    return pose ? { x: pose.x, y: pose.y, scale: pose.scale, opacity: 0.72 } : null;
  }, [drill]);
  const exitPose = useMemo(() => {
    if (drill?.direction !== 'exit') return null;
    const pose = drillPose(drill.anchor);
    return pose ? { x: pose.x, y: pose.y, scale: pose.scale, opacity: 0.55 } : null;
  }, [drill]);

  if (!graph) return null;

  return (
    <motion.div
      key={graphLocationKey(location)}
      className={drill ? 'graph-drill graph-drill-active' : 'graph-drill'}
      data-drill={drill?.direction}
      initial={enterPose ?? false}
      animate={exitPose ?? DRILL_REST}
      transition={DRILL_TWEEN}
    >
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
          interactionLocked={interactionLocked || drill !== null}
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
    </motion.div>
  );
});
