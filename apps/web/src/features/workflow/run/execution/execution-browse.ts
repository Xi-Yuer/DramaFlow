import {
  executionTreeQuerySchema,
  type ExecutionTreeEntry,
  type ExecutionTreeParentRef,
  type ExecutionTreeQuery,
  type ExecutionTreeResponse,
  type NodeDefinition,
  type NodeRunError,
  type NodeRunStatus,
  type WorkflowDefinition,
} from '@dramaflow/contracts';

export const EXECUTION_ROOT_LABEL = 'Workflow Run';

export interface ExecutionBrowseFrame {
  parent: ExecutionTreeParentRef;
  label: string;
}

// 当前层仍是 Execution Tree 条目。投影只抽出 NodeRun，方便以后覆盖到图定义。
export interface ExecutionLayerSnapshot {
  parent: ExecutionTreeParentRef;
  items: readonly ExecutionTreeEntry[];
  nextCursor: string | null;
}

export interface ExecutionNodeProjection {
  type: 'node_run';
  id: string;
  nodeId: string;
  occurrenceId: string;
  attempt: number;
  status: NodeRunStatus;
  parent: ExecutionTreeParentRef;
  error?: NodeRunError;
}

export function sameExecutionParent(
  left: ExecutionTreeParentRef,
  right: ExecutionTreeParentRef,
): boolean {
  return left.type === right.type && left.id === right.id;
}

export function rootBrowseFrame(runId: string): ExecutionBrowseFrame {
  return { parent: { type: 'workflow_run', id: runId }, label: EXECUTION_ROOT_LABEL };
}

export function executionLayerKey(
  runId: string,
  parent: ExecutionTreeParentRef,
  reloadKey: string,
  pageSize: number,
): string {
  return JSON.stringify([reloadKey, pageSize, runId, parent.type, parent.id]);
}

export function executionTreeQuery(
  parent: ExecutionTreeParentRef,
  page?: { limit?: number; after?: string | null },
): ExecutionTreeQuery {
  return executionTreeQuerySchema.parse({
    parentType: parent.type,
    parentId: parent.id,
    ...(page?.limit !== undefined ? { limit: page.limit } : {}),
    ...(page?.after ? { after: page.after } : {}),
  });
}

export function indexDefinitionNodeNames(
  definition: Pick<WorkflowDefinition, 'nodes'> | null | undefined,
): ReadonlyMap<string, string | null> {
  const found = new Map<string, string[]>();
  const visit = (nodes: readonly NodeDefinition[]) => {
    for (const node of nodes) {
      const names = found.get(node.id);
      if (names) names.push(node.name);
      else found.set(node.id, [node.name]);
      if (node.composite?.kind === 'iteration') visit(node.composite.body.nodes);
    }
  };
  if (definition) visit(definition.nodes);
  const indexed = new Map<string, string | null>();
  for (const [id, names] of found) {
    const [first] = names;
    indexed.set(id, first !== undefined && names.every((name) => name === first) ? first : null);
  }
  return indexed;
}

export function definitionNodeLabel(
  names: ReadonlyMap<string, string | null>,
  nodeId: string,
): string {
  return names.get(nodeId) || '节点';
}

export function nodeRunBreadcrumbLabel(name: string, attempt: number): string {
  return attempt > 1 ? `${name} · 第 ${attempt} 次` : name;
}

export function childExecutionLabel(entry: {
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}): string {
  const index = entry.metadata?.index;
  if (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0) return `#${index}`;
  return '子执行';
}

export function projectExecutionNodeRuns(
  items: readonly ExecutionTreeEntry[],
): ExecutionNodeProjection[] {
  const projected: ExecutionNodeProjection[] = [];
  for (const item of items) {
    if (item.type !== 'node_run') continue;
    projected.push({
      type: 'node_run',
      id: item.id,
      nodeId: item.nodeId,
      occurrenceId: item.occurrenceId,
      attempt: item.attempt,
      status: item.status,
      parent: item.parent,
      ...(item.error ? { error: item.error } : {}),
    });
  }
  return projected;
}

export function acceptExecutionPage(
  expected: { runId: string; parent: ExecutionTreeParentRef },
  page: ExecutionTreeResponse,
): ExecutionLayerSnapshot | null {
  if (page.run.id !== expected.runId || !sameExecutionParent(page.parent, expected.parent))
    return null;
  if (page.items.some((item) => !sameExecutionParent(item.parent, expected.parent))) return null;
  return { parent: expected.parent, items: [...page.items], nextCursor: page.nextCursor };
}

export function appendExecutionItems(
  current: readonly ExecutionTreeEntry[],
  page: Pick<ExecutionLayerSnapshot, 'items'>,
): ExecutionTreeEntry[] {
  const seen = new Set(current.map((item) => `${item.type}\u0000${item.id}`));
  const items = [...current];
  for (const item of page.items) {
    const key = `${item.type}\u0000${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

export function enterExecution(
  path: readonly ExecutionBrowseFrame[],
  entry: ExecutionTreeEntry,
  label: string,
): readonly ExecutionBrowseFrame[] | null {
  const current = path.at(-1);
  if (!current || !sameExecutionParent(current.parent, entry.parent)) return null;
  const parent: ExecutionTreeParentRef =
    entry.type === 'node_run'
      ? { type: 'node_run', id: entry.id }
      : { type: 'child_execution', id: entry.id };
  return [...path, { parent, label }];
}

export function exitExecution(
  path: readonly ExecutionBrowseFrame[],
): readonly ExecutionBrowseFrame[] {
  return path.length > 1 ? path.slice(0, -1) : path;
}

export function focusExecution(
  path: readonly ExecutionBrowseFrame[],
  index: number,
): readonly ExecutionBrowseFrame[] {
  if (!Number.isInteger(index) || index < 0 || index >= path.length - 1) return path;
  return path.slice(0, index + 1);
}
