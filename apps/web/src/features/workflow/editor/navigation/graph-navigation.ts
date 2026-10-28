import {
  nestedGraphSlots,
  isSubworkflowNodeManifest,
  type GraphDefinition,
  type GraphDefinitionPath,
  type NodeDefinition,
  type NodeTypeManifest,
  type WorkflowDefinition,
} from '@dramaflow/contracts';

// 编辑导航使用 Definition Location。空路径是 root，不携带 scope、版本或执行身份。
export type GraphLocation = GraphDefinitionPath;

export interface GraphViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface GraphViewState {
  selectedNodeId: string | null;
  selectedEdgeIds: readonly string[];
  viewport: GraphViewport;
}

export interface NavigationLayer {
  location: GraphLocation;
  label: string;
}

export interface GraphNavigationState {
  stack: readonly NavigationLayer[];
  views: Readonly<Record<string, GraphViewState>>;
}

export interface GraphViewportController {
  getViewport: () => GraphViewport;
  setViewport: (viewport: GraphViewport) => void;
}

export const rootNavigationLabel = '主流程';
export const rootGraphLocation: GraphLocation = [];

const emptyView: GraphViewState = {
  selectedNodeId: null,
  selectedEdgeIds: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};

export function graphLocationKey(location: GraphLocation): string {
  return location.length === 0 ? 'root' : JSON.stringify(location);
}

export function currentGraphLocation(state: GraphNavigationState): GraphLocation {
  return state.stack[state.stack.length - 1]?.location ?? rootGraphLocation;
}

export function createGraphNavigation(rootViewport: GraphViewport): GraphNavigationState {
  return {
    stack: [{ location: rootGraphLocation, label: rootNavigationLabel }],
    views: { root: { ...emptyView, viewport: rootViewport } },
  };
}

export function patchGraphView(
  state: GraphNavigationState,
  location: GraphLocation,
  patch: Partial<GraphViewState>,
): GraphNavigationState {
  const key = graphLocationKey(location);
  const current = state.views[key] ?? emptyView;
  const next = { ...current, ...patch };
  if (
    next.selectedNodeId === current.selectedNodeId &&
    next.selectedEdgeIds.length === current.selectedEdgeIds.length &&
    next.selectedEdgeIds.every((id, index) => id === current.selectedEdgeIds[index]) &&
    next.viewport.x === current.viewport.x &&
    next.viewport.y === current.viewport.y &&
    next.viewport.zoom === current.viewport.zoom
  ) {
    return state;
  }
  return { ...state, views: { ...state.views, [key]: next } };
}

export function readLocatedGraph(
  workflow: WorkflowDefinition,
  location: GraphLocation,
): GraphDefinition | null {
  let graph: GraphDefinition = workflow;
  for (const step of location) {
    const owner = graph.nodes.find((node) => node.id === step.nodeId);
    const slot = owner?.composite
      ? nestedGraphSlots(owner).find((item) => item.graphKey === step.graphKey)
      : undefined;
    if (!slot) return null;
    graph = slot.graph;
  }
  return graph;
}

function replaceNestedGraph(
  graph: GraphDefinition,
  location: GraphLocation,
  next: GraphDefinition,
): GraphDefinition | null {
  const [step, ...rest] = location;
  if (!step) return next;
  let found = false;
  const nodes = graph.nodes.map((node) => {
    if (found || node.id !== step.nodeId) return node;
    const updated = writeNodeGraph(
      node,
      step.graphKey,
      rest.length === 0 ? next : null,
      rest,
      next,
    );
    if (!updated) return node;
    found = true;
    return updated;
  });
  return found ? { ...graph, nodes } : null;
}

function writeNodeGraph(
  node: NodeDefinition,
  graphKey: GraphDefinitionPath[number]['graphKey'],
  direct: GraphDefinition | null,
  rest: GraphLocation,
  next: GraphDefinition,
): NodeDefinition | null {
  const composite = node.composite;
  if (!composite || !nestedGraphSlots(node).some((slot) => slot.graphKey === graphKey)) return null;
  const current = nestedGraphSlots(node).find((slot) => slot.graphKey === graphKey)!.graph;
  const child = direct ?? replaceNestedGraph(current, rest, next);
  if (!child) return null;
  if (composite.kind === 'iteration' && graphKey === 'body')
    return { ...node, composite: { ...composite, body: child } };
  if (composite.kind === 'subworkflow' && graphKey === 'graph')
    return { ...node, composite: { ...composite, graph: child } };
  return null;
}

export function writeLocatedGraph(
  workflow: WorkflowDefinition,
  location: GraphLocation,
  graph: WorkflowDefinition,
): WorkflowDefinition {
  if (location.length === 0) return graph;
  return replaceNestedGraph(workflow, location, graph) ?? workflow;
}

export function editLocatedGraph(
  workflow: WorkflowDefinition,
  location: GraphLocation,
  apply: (graph: WorkflowDefinition) => WorkflowDefinition,
): WorkflowDefinition {
  const current = readLocatedGraph(workflow, location);
  if (!current) return workflow;
  return writeLocatedGraph(workflow, location, apply(current));
}

export function enterNestedGraph(
  state: GraphNavigationState,
  workflow: WorkflowDefinition,
  ownerNodeId: string,
): GraphNavigationState {
  const location = currentGraphLocation(state);
  const graph = readLocatedGraph(workflow, location);
  const owner = graph?.nodes.find((node) => node.id === ownerNodeId);
  const slot = owner ? nestedGraphSlots(owner)[0] : undefined;
  if (!owner || !slot) return state;
  const next: GraphLocation = [...location, { nodeId: owner.id, graphKey: slot.graphKey }];
  const key = graphLocationKey(next);
  return {
    stack: [...state.stack, { location: next, label: owner.name }],
    views: { ...state.views, [key]: state.views[key] ?? emptyView },
  };
}

export function popGraph(state: GraphNavigationState): GraphNavigationState {
  if (state.stack.length <= 1) return state;
  return { ...state, stack: state.stack.slice(0, -1) };
}

export function jumpToGraph(state: GraphNavigationState, index: number): GraphNavigationState {
  if (index < 0 || index >= state.stack.length - 1) return state;
  return { ...state, stack: state.stack.slice(0, index + 1) };
}

export function retreatToExistingGraph(
  state: GraphNavigationState,
  workflow: WorkflowDefinition,
): GraphNavigationState {
  let next = state;
  while (next.stack.length > 1 && !readLocatedGraph(workflow, currentGraphLocation(next)))
    next = popGraph(next);
  return next;
}

export function navigationCrumbs(
  workflow: WorkflowDefinition,
  state: GraphNavigationState,
): { location: GraphLocation; label: string }[] {
  return state.stack.map((layer, index) => {
    if (index === 0) return { location: layer.location, label: rootNavigationLabel };
    const step = layer.location[layer.location.length - 1];
    const parent = step ? readLocatedGraph(workflow, layer.location.slice(0, -1)) : null;
    const owner = parent?.nodes.find((node) => node.id === step?.nodeId);
    return { location: layer.location, label: owner?.name ?? layer.label };
  });
}

// 与 Publish 的 iteration body v1 可见条件一致：普通 Action（无控制出口）或精确 SubWorkflow v1。Web 看不到 execute。
export function isIterationBodyNode(manifest: NodeTypeManifest): boolean {
  return isSubworkflowNodeManifest(manifest) || isOrdinaryGraphAction(manifest);
}

export function isOrdinaryGraphAction(manifest: NodeTypeManifest): boolean {
  return manifest.executionKind === 'action' && (manifest.controlOutputs?.length ?? 0) === 0;
}
