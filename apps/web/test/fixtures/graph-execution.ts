import {
  StringType,
  type ExecutionTreeEntry,
  type ExecutionTreeResponse,
  type NodeDefinition,
  type NodeRun,
  type WorkflowDefinition,
  type WorkflowRunResponse,
  type WorkflowVersionResponse,
} from '@dramaflow/contracts';
import type { WorkflowRunStatusState } from '../../src/features/workflow/run/status/workflow-run-status';

export const executionTime = '2026-10-27T00:00:00.000Z';
export function graphExecutionFixture() {
  const action: NodeDefinition = {
    id: 'generate',
    type: 'ai.text_generate',
    typeVersion: 1,
    name: 'AI 文本生成',
    inputs: { prompt: { type: 'workflow_input', key: 'text' } },
    config: {},
    ui: { position: { x: 320, y: 160 } },
  };
  const child: WorkflowDefinition = {
    inputs: [{ name: 'text', type: StringType, required: true }],
    nodes: [action],
    edges: [],
    outputs: [
      { name: 'result', type: StringType, source: { nodeId: action.id, outputKey: 'text' } },
    ],
  };
  const owner: NodeDefinition = {
    id: 'process_text',
    type: 'flow.subworkflow',
    typeVersion: 1,
    name: 'AI 文本处理',
    inputs: { text: { type: 'workflow_input', key: 'text' } },
    config: {},
    ui: { position: { x: 320, y: 160 } },
    composite: { kind: 'subworkflow', graph: child },
  };
  const workflow: WorkflowDefinition = {
    inputs: child.inputs,
    nodes: [owner],
    edges: [],
    outputs: [
      { name: 'result', type: StringType, source: { nodeId: owner.id, outputKey: 'result' } },
    ],
  };
  const run: WorkflowRunResponse = {
    id: 'run',
    workflowId: 'workflow',
    workflowVersionId: 'version',
    invocationKey: 'invocation',
    status: 'completed',
    inputs: {},
    createdAt: executionTime,
  };
  const projectId = '00000000-0000-4000-8000-000000000001';
  const version: WorkflowVersionResponse = {
    id: 'version',
    workflowId: 'workflow',
    projectId,
    version: 1,
    sourceRevision: 1,
    publishedAt: executionTime,
    definition: structuredClone(workflow),
  };
  const parentRun: NodeRun = {
    id: 'parent-attempt-1',
    workflowRunId: run.id,
    nodeId: owner.id,
    occurrenceId: 'parent-occurrence',
    scopeKey: 'root',
    attempt: 1,
    status: 'completed',
    startedAt: executionTime,
  };
  const childRun: NodeRun = {
    ...parentRun,
    id: 'child-attempt-1',
    nodeId: action.id,
    occurrenceId: 'child-occurrence',
    scopeKey: 'opaque-1',
    childExecutionId: 'child-execution-1',
  };
  const nodeRuns = [parentRun, childRun];
  const runStatus: WorkflowRunStatusState = {
    phase: 'ready',
    runId: run.id,
    run,
    nodeRuns,
    error: null,
    refreshing: false,
    review: null,
  };
  const execution: ExecutionTreeEntry = {
    type: 'child_execution',
    id: 'child-execution-1',
    kind: 'subworkflow',
    parent: { type: 'node_run', id: parentRun.id },
    status: 'completed',
    metadata: {},
    startedAt: executionTime,
    createdAt: executionTime,
  };
  const page = (
    items: ExecutionTreeEntry[] = [execution],
    nextCursor: string | null = null,
  ): ExecutionTreeResponse => ({
    run: { ...run, type: 'workflow_run' },
    parent: execution.parent,
    items,
    nextCursor,
  });
  const location: { nodeId: string; graphKey: 'graph' | 'body' }[] = [
    { nodeId: owner.id, graphKey: 'graph' },
  ];
  return {
    workflow,
    child,
    owner,
    action,
    run,
    version,
    projectId,
    parentRun,
    childRun,
    nodeRuns,
    runStatus,
    execution,
    page,
    location,
  };
}

export function iterationExecutionFixture(indexes = [2, 0, 1]) {
  const f = graphExecutionFixture();
  f.owner.type = 'flow.iteration';
  f.owner.name = '逐项处理';
  f.owner.inputs = { items: { type: 'constant', value: ['A', 'B', 'C'] } };
  f.owner.composite = {
    kind: 'iteration',
    itemType: StringType,
    invariantInputs: [],
    bodyInputMapping: [{ target: 'text', source: { type: 'current_item' } }],
    body: f.child,
  };
  f.workflow.inputs = [];
  f.workflow.outputs[0]!.type = { kind: 'array', itemType: StringType };
  f.version.definition = structuredClone(f.workflow);
  f.location[0]!.graphKey = 'body';
  const executions: Extract<ExecutionTreeEntry, { type: 'child_execution' }>[] = indexes.map(
    (index) => ({
      ...f.execution,
      type: 'child_execution',
      kind: 'iteration_item',
      id: `item-${index}`,
      metadata: { index },
    }),
  );
  const itemRuns: NodeRun[] = indexes.map((index) => ({
    ...f.childRun,
    id: `item-node-run-${index}`,
    childExecutionId: `item-${index}`,
    occurrenceId: `item-occurrence-${index}`,
    scopeKey: `opaque-${index}`,
    status: index === 0 ? 'completed' : index === 1 ? 'failed' : 'running',
    outputs: { text: { storage: 'inline', type: StringType, value: `Item ${index + 1} output` } },
  }));
  f.nodeRuns.splice(0, f.nodeRuns.length, f.parentRun, ...itemRuns);
  return { ...f, executions, itemRuns };
}

export function iterationSubworkflowExecutionFixture() {
  const f = iterationExecutionFixture();
  const inner = structuredClone(f.child);
  inner.nodes[0]!.id = 'action';
  inner.outputs[0]!.source = { nodeId: 'action', outputKey: 'text' };
  const sub: NodeDefinition = {
    ...f.owner,
    id: 'sub',
    name: '子流程',
    type: 'flow.subworkflow',
    inputs: { text: { type: 'workflow_input', key: 'text' } },
    composite: { kind: 'subworkflow', graph: inner },
  };
  f.child.nodes = [sub];
  f.child.outputs[0]!.source = { nodeId: 'sub', outputKey: 'result' };
  for (const record of f.itemRuns) record.nodeId = 'sub';
  const calls: Extract<ExecutionTreeEntry, { type: 'child_execution' }>[] = f.itemRuns.map(
    (parent) => ({
      ...f.execution,
      type: 'child_execution',
      kind: 'subworkflow',
      id: `sub-${parent.childExecutionId}`,
      parent: { type: 'node_run', id: parent.id },
      metadata: {},
      status: parent.status,
    }),
  );
  const actionRuns: NodeRun[] = f.itemRuns.map((parent, index) => ({
    ...parent,
    id: `action-${parent.id}`,
    nodeId: 'action',
    occurrenceId: `action-${parent.occurrenceId}`,
    childExecutionId: calls[index]!.id,
    scopeKey: `action-scope-${index}`,
    outputs: {
      text: {
        storage: 'inline',
        type: StringType,
        value: `Action ${parent.childExecutionId} output`,
      },
    },
    ...(parent.status === 'failed'
      ? {
          error: {
            code: 'NODE_EXECUTION_FAILED',
            stage: 'execute',
            message: `Error ${parent.childExecutionId}`,
          },
        }
      : {}),
  }));
  f.nodeRuns.push(...actionRuns);
  f.version.definition = structuredClone(f.workflow);
  const descendant = [...f.location, { nodeId: 'sub', graphKey: 'graph' as const }];
  const treePage = (
    parentId: string,
    items?: ExecutionTreeEntry[],
    nextCursor: string | null = null,
  ): ExecutionTreeResponse => ({
    run: { ...f.run, type: 'workflow_run' },
    parent: { type: 'node_run', id: parentId },
    items:
      items ??
      (parentId === f.parentRun.id
        ? f.executions
        : calls.filter((call) => call.parent.id === parentId)),
    nextCursor,
  });
  return { ...f, sub, inner, calls, actionRuns, descendant, treePage };
}
