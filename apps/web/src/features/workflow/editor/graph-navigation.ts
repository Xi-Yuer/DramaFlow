import type { NodeDefinition, NodeTypeManifest, WorkflowDefinition } from '@dramaflow/contracts';

// 编辑器导航，不是 Runtime 的 Definition Location。概念同为 root / body，但不携带版本、scope 或执行身份。
export interface RootGraphLocation {
  kind: 'root';
}

export interface NestedGraphLocation {
  kind: 'nested';
  ownerNodeId: string;
  graphKey: 'body';
}

export type GraphLocation = RootGraphLocation | NestedGraphLocation;

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

export interface GraphNavigationState {
  stack: readonly GraphLocation[];
  views: Readonly<Record<string, GraphViewState>>;
}

export interface GraphViewportController {
  getViewport: () => GraphViewport;
  setViewport: (viewport: GraphViewport) => void;
}

export const rootGraphLocation: RootGraphLocation = { kind: 'root' };

const emptyView: GraphViewState = {
  selectedNodeId: null,
  selectedEdgeIds: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};

export function graphLocationKey(location: GraphLocation): string {
  return location.kind === 'root'
    ? 'root'
    : JSON.stringify({
        kind: location.kind,
        ownerNodeId: location.ownerNodeId,
        graphKey: location.graphKey,
      });
}

export function currentGraphLocation(state: GraphNavigationState): GraphLocation {
  return state.stack[state.stack.length - 1] ?? rootGraphLocation;
}

export function createGraphNavigation(rootViewport: GraphViewport): GraphNavigationState {
  return {
    stack: [rootGraphLocation],
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

export function canEnterIterationBody(node: NodeDefinition | undefined): node is NodeDefinition & {
  composite: Extract<NonNullable<NodeDefinition['composite']>, { kind: 'iteration' }>;
} {
  return (
    !!node &&
    node.type === 'flow.iteration' &&
    node.typeVersion === 1 &&
    node.composite?.kind === 'iteration' &&
    node.composite.body !== undefined
  );
}

// 只压入一层 body。更深的 nested graph 以后追加 graphKey，不把父节点写进子图 nodeId。
export function enterIterationBody(
  state: GraphNavigationState,
  ownerNodeId: string,
): GraphNavigationState {
  if (currentGraphLocation(state).kind !== 'root') return state;
  const next: NestedGraphLocation = { kind: 'nested', ownerNodeId, graphKey: 'body' };
  const key = graphLocationKey(next);
  return {
    stack: [...state.stack, next],
    views: { ...state.views, [key]: state.views[key] ?? emptyView },
  };
}

export function exitToRoot(state: GraphNavigationState): GraphNavigationState {
  if (currentGraphLocation(state).kind === 'root') return state;
  return { ...state, stack: state.stack.slice(0, -1) };
}

export function readLocatedGraph(
  workflow: WorkflowDefinition,
  location: GraphLocation,
): WorkflowDefinition | null {
  if (location.kind === 'root') return workflow;
  const owner = workflow.nodes.find((node) => node.id === location.ownerNodeId);
  if (!canEnterIterationBody(owner)) return null;
  return owner.composite.body;
}

export function writeLocatedGraph(
  workflow: WorkflowDefinition,
  location: GraphLocation,
  graph: WorkflowDefinition,
): WorkflowDefinition {
  if (location.kind === 'root') return graph;
  let found = false;
  const nodes = workflow.nodes.map((node) => {
    if (node.id !== location.ownerNodeId || !canEnterIterationBody(node)) return node;
    found = true;
    return { ...node, composite: { ...node.composite, body: graph } };
  });
  return found ? { ...workflow, nodes } : workflow;
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

// 与 Publish 的 iteration body v1 可见条件一致：普通 Action，且没有控制出口。Web 看不到 execute。
export function isIterationBodyAction(manifest: NodeTypeManifest): boolean {
  return manifest.executionKind === 'action' && (manifest.controlOutputs?.length ?? 0) === 0;
}
