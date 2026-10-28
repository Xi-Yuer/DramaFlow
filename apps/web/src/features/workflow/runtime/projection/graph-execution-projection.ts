import {
  ROOT_EXECUTION_SCOPE_KEY,
  nestedGraphSlots,
  type ExecutionTreeEntry,
  type ExecutionTreeParentRef,
  type GraphDefinitionPath,
  type NodeRun,
  type WorkflowDefinition,
  type WorkflowRunResponse,
  type WorkflowVersionResponse,
} from '@dramaflow/contracts';
import type { ExecutionTreeLoad } from '../../run/execution/use-execution-layer';
import { acceptExecutionPage } from '../../run/execution/execution-browse';

export type GraphExecutionInstance = Exclude<ExecutionTreeParentRef, { type: 'node_run' }>;
export interface GraphExecutionSelection {
  workflowRunId: string;
  definition: { workflowVersionId: string; path: GraphDefinitionPath };
  parentNodeRunId: string;
  parentInstance: GraphExecutionInstance;
  candidates: readonly {
    executionId: string;
    kind: string;
    metadata: Extract<ExecutionTreeEntry, { type: 'child_execution' }>['metadata'];
  }[];
}
export interface GraphExecutionChoice {
  workflowRunId: string;
  definition: GraphExecutionSelection['definition'];
  parentInstance: GraphExecutionInstance;
  parentNodeRunId: string;
  executionId: string;
}
export function graphExecutionChoiceKey(
  input: Pick<GraphExecutionChoice, 'workflowRunId' | 'definition'>,
): string {
  return JSON.stringify([
    input.workflowRunId,
    input.definition.workflowVersionId,
    input.definition.path.map(({ nodeId, graphKey }) => [nodeId, graphKey]),
  ]);
}
export function graphPathContains(
  ancestor: GraphDefinitionPath,
  path: GraphDefinitionPath,
): boolean {
  return (
    ancestor.length <= path.length &&
    ancestor.every(
      (step, index) =>
        step.nodeId === path[index]?.nodeId && step.graphKey === path[index]?.graphKey,
    )
  );
}
export function validGraphExecutionChoice(
  selection: GraphExecutionSelection,
  choice: GraphExecutionChoice,
): boolean {
  return (
    graphExecutionChoiceKey(selection) === graphExecutionChoiceKey(choice) &&
    selection.parentNodeRunId === choice.parentNodeRunId &&
    selection.parentInstance.type === choice.parentInstance.type &&
    selection.parentInstance.id === choice.parentInstance.id &&
    selection.candidates.some((candidate) => candidate.executionId === choice.executionId)
  );
}
export type GraphExecutionProjection = (
  | {
      phase: 'resolved';
      definition: { workflowVersionId: string; path: GraphDefinitionPath };
      instance: GraphExecutionInstance;
      nodeRuns: readonly NodeRun[];
    }
  | {
      phase: 'no_execution' | 'loading' | 'ambiguous' | 'version_mismatch' | 'unavailable';
      reason: string;
    }
) & { selection?: GraphExecutionSelection };

// 对象键顺序不影响匹配；仅节点画布位置不属于执行定义。其他字段保守地逐项核对。
export function executionDefinitionSignature(definition: WorkflowDefinition): string {
  const graph = (definition: WorkflowDefinition): unknown => ({
    ...definition,
    nodes: definition.nodes.map(({ composite, ...node }) => ({
      ...node,
      ui: undefined,
      ...(composite?.kind === 'iteration'
        ? { composite: { ...composite, body: graph(composite.body) } }
        : composite?.kind === 'subworkflow'
          ? { composite: { ...composite, graph: graph(composite.graph) } }
          : {}),
    })),
  });
  return JSON.stringify(graph(definition), (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value))
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    return value;
  });
}

// 先确定 graph instance，再在其直属记录中按局部 nodeId / occurrence / attempt 分组。
export function directGraphNodeRuns(
  nodeRuns: readonly NodeRun[],
  instance: GraphExecutionInstance,
): readonly NodeRun[] {
  return nodeRuns.filter((record) =>
    instance.type === 'workflow_run'
      ? record.childExecutionId === undefined && record.scopeKey === ROOT_EXECUTION_SCOPE_KEY
      : record.childExecutionId === instance.id,
  );
}

export function groupGraphNodeAttempts(nodeRuns: readonly NodeRun[]): Map<string, NodeRun[]> {
  const grouped = new Map<string, NodeRun[]>();
  for (const record of nodeRuns) {
    const attempts = grouped.get(record.nodeId) ?? [];
    if (attempts.some((item) => item.occurrenceId !== record.occurrenceId))
      throw new Error('同一 graph 节点存在多个 occurrence，必须明确选择执行实例');
    if (attempts.some((item) => item.attempt === record.attempt))
      throw new Error('同一 occurrence 存在重复 attempt');
    attempts.push(record);
    grouped.set(record.nodeId, attempts);
  }
  for (const attempts of grouped.values()) attempts.sort((a, b) => a.attempt - b.attempt);
  return grouped;
}

export function projectRootGraphExecution(input: {
  workflow: WorkflowDefinition;
  workflowId: string;
  projectId: string;
  run: WorkflowRunResponse;
  version: WorkflowVersionResponse;
  nodeRuns: readonly NodeRun[];
}): GraphExecutionProjection {
  const { run, version, nodeRuns } = input;
  if (
    run.workflowId !== input.workflowId ||
    version.id !== run.workflowVersionId ||
    version.workflowId !== run.workflowId ||
    version.projectId !== input.projectId ||
    executionDefinitionSignature(input.workflow) !==
      executionDefinitionSignature(version.definition)
  )
    return {
      phase: 'version_mismatch',
      reason: '当前草稿与该运行的发布版本不匹配，暂不显示执行状态。',
    };
  if (nodeRuns.some((record) => record.workflowRunId !== run.id))
    return { phase: 'unavailable', reason: '节点运行记录不属于当前工作流运行。' };
  return projectInstance({ type: 'workflow_run', id: run.id }, nodeRuns, version.id, []);
}

function projectInstance(
  instance: GraphExecutionInstance,
  allNodeRuns: readonly NodeRun[],
  workflowVersionId: string,
  path: GraphDefinitionPath,
): GraphExecutionProjection {
  const nodeRuns = directGraphNodeRuns(allNodeRuns, instance);
  try {
    groupGraphNodeAttempts(nodeRuns);
  } catch (error) {
    return {
      phase: 'ambiguous',
      reason: error instanceof Error ? error.message : '节点执行身份不明确。',
    };
  }
  return { phase: 'resolved', instance, definition: { workflowVersionId, path }, nodeRuns };
}

// UI 只提交真实 executionId；节点状态继续通过同一个 graph instance 投影计算。
export function selectGraphExecutionInstance({
  selection,
  executionId,
  nodeRuns,
}: {
  selection: GraphExecutionSelection;
  executionId: string;
  nodeRuns: readonly NodeRun[];
}): GraphExecutionProjection {
  if (nodeRuns.some((record) => record.workflowRunId !== selection.workflowRunId))
    return { phase: 'unavailable', reason: '节点运行记录不属于当前工作流运行。' };
  if (!selection.candidates.some((candidate) => candidate.executionId === executionId))
    return { phase: 'ambiguous', reason: '所选子执行不在当前执行实例集合中。', selection };
  return {
    ...projectInstance(
      { type: 'child_execution', id: executionId },
      nodeRuns,
      selection.definition.workflowVersionId,
      selection.definition.path,
    ),
    selection,
  };
}

// 只有遍历全部分页后才能认定唯一或不存在。cursor 循环、跨 Run / parent 响应均拒绝。
export async function loadExecutionChildren(
  load: ExecutionTreeLoad,
  run: Pick<WorkflowRunResponse, 'id' | 'workflowId' | 'workflowVersionId'>,
  parent: ExecutionTreeParentRef,
  signal?: AbortSignal,
): Promise<ExecutionTreeEntry[]> {
  const items: ExecutionTreeEntry[] = [];
  const cursors = new Set<string>();
  const identities = new Set<string>();
  let after: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await load(
      run.id,
      { parentType: parent.type, parentId: parent.id, limit: 50, ...(after ? { after } : {}) },
      signal,
    );
    if (
      !acceptExecutionPage({ runId: run.id, parent }, page) ||
      page.run.workflowId !== run.workflowId ||
      page.run.workflowVersionId !== run.workflowVersionId
    )
      throw new Error('执行树响应与当前运行、版本或父执行不一致。');
    for (const item of page.items) {
      const identity = `${item.type}:${item.id}`;
      if (identities.has(identity)) throw new Error('执行树分页包含重复记录，请刷新后重试。');
      identities.add(identity);
      items.push(item);
    }
    after = page.nextCursor ?? undefined;
    if (after && cursors.has(after)) throw new Error('执行树分页位置重复。');
    if (after) cursors.add(after);
  } while (after);
  return items;
}

export interface NestedGraphExecutionInput {
  root: Extract<GraphExecutionProjection, { phase: 'resolved' }>;
  location: GraphDefinitionPath;
  version: WorkflowVersionResponse;
  run: WorkflowRunResponse;
  nodeRuns: readonly NodeRun[];
  choices?: readonly GraphExecutionChoice[];
}
// 同一逐层解析供异步加载与同步缓存读取使用；每步只消费当前父实例的直属记录。
function* graphExecutionPath(
  input: NestedGraphExecutionInput,
): Generator<ExecutionTreeParentRef, GraphExecutionProjection, readonly ExecutionTreeEntry[]> {
  let current: GraphExecutionProjection = input.root;
  if (
    input.root.definition.workflowVersionId !== input.version.id ||
    input.run.workflowVersionId !== input.version.id
  )
    return { phase: 'version_mismatch', reason: '执行选择与运行绑定的版本不一致。' };
  if (input.root.instance.type !== 'workflow_run' || input.root.instance.id !== input.run.id)
    return { phase: 'unavailable', reason: '根执行实例不属于当前运行。' };
  let graph = input.version.definition;
  for (const step of input.location) {
    if (current.phase !== 'resolved') return current;
    const owner = graph.nodes.find((node) => node.id === step.nodeId);
    const slots = owner ? nestedGraphSlots(owner) : [];
    const slot = slots.find((slot) => slot.graphKey === step.graphKey);
    if (!slot) return { phase: 'version_mismatch', reason: '该定义位置不属于运行绑定的发布版本。' };
    if (slots.length !== 1)
      return { phase: 'unavailable', reason: '当前执行记录无法唯一关联到子图槽位。' };
    const ownerAttempts = groupGraphNodeAttempts(current.nodeRuns).get(step.nodeId);
    const attempt = ownerAttempts?.at(-1);
    if (!attempt)
      return { phase: 'no_execution', reason: '该节点在当前 graph 执行实例中尚无运行记录。' };
    const children = yield { type: 'node_run', id: attempt.id };
    if (children.some((entry) => entry.type !== 'child_execution'))
      return { phase: 'unavailable', reason: '父节点下返回了不匹配的执行记录。' };
    if (children.length === 0)
      return { phase: 'no_execution', reason: '当前父节点 attempt 尚无子执行。' };
    const selection: GraphExecutionSelection = {
      workflowRunId: input.run.id,
      definition: { workflowVersionId: input.version.id, path: [...current.definition.path, step] },
      parentNodeRunId: attempt.id,
      parentInstance: current.instance,
      candidates: children.flatMap((child) =>
        child.type === 'child_execution'
          ? [{ executionId: child.id, kind: child.kind, metadata: child.metadata }]
          : [],
      ),
    };
    const choice = input.choices?.find(
      (choice) => graphExecutionChoiceKey(choice) === graphExecutionChoiceKey(selection),
    );
    if (choice && !validGraphExecutionChoice(selection, choice))
      return {
        phase: 'unavailable',
        reason: '原先选择的子执行已不存在或不再属于当前父执行，请重新选择。',
        selection,
      };
    if (!choice && children.length !== 1)
      return {
        phase: 'ambiguous',
        reason: '该子图有多个执行实例，需要明确选择子执行。',
        selection,
      };
    current = selectGraphExecutionInstance({
      selection,
      executionId: choice?.executionId ?? children[0]!.id,
      nodeRuns: input.nodeRuns,
    });
    graph = slot.graph;
  }
  return current;
}

export async function resolveNestedGraphExecution(
  input: NestedGraphExecutionInput & {
    load: ExecutionTreeLoad;
    signal?: AbortSignal;
    loadChildren?: (parent: ExecutionTreeParentRef) => Promise<readonly ExecutionTreeEntry[]>;
  },
): Promise<GraphExecutionProjection> {
  const path = graphExecutionPath(input);
  let step = path.next();
  while (!step.done) {
    input.signal?.throwIfAborted();
    const children = await (input.loadChildren?.(step.value) ??
      loadExecutionChildren(input.load, input.run, step.value, input.signal));
    input.signal?.throwIfAborted();
    step = path.next(children);
  }
  return step.value;
}

export function projectCachedNestedGraphExecution(
  input: NestedGraphExecutionInput & {
    readChildren: (parent: ExecutionTreeParentRef) => readonly ExecutionTreeEntry[] | undefined;
  },
): GraphExecutionProjection | undefined {
  const path = graphExecutionPath(input);
  let step = path.next();
  while (!step.done) {
    const children = input.readChildren(step.value);
    if (children === undefined) return undefined;
    step = path.next(children);
  }
  return step.value;
}
