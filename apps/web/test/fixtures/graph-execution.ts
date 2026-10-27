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
