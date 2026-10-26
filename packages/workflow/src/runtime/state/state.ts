import {
  nodeOutputMapSchema,
  runtimeValueMapSchema,
  workflowIdentifierSchema,
  type NodeOutputMap,
  type RuntimeValue,
} from '@dramaflow/contracts';
import { Annotation } from '@langchain/langgraph';
import { z } from 'zod';
export interface WorkflowRunContext {
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly workflowRunId: string;
  readonly projectId: string;
}
export interface WorkflowExecutionState {
  readonly controlResults?: Readonly<Record<string, boolean>>;
}
export interface WorkflowState {
  readonly run: WorkflowRunContext;
  readonly inputs: Readonly<Record<string, RuntimeValue>>;
  readonly outputs: NodeOutputMap;
  readonly variables: Readonly<Record<string, RuntimeValue>>;
  readonly execution: WorkflowExecutionState;
}
export interface WorkflowStateUpdate {
  outputs?: NodeOutputMap;
  execution?: WorkflowExecutionState;
}

// 外部 Graph / checkpoint 返回值在已有 State 模块校验，不另造中断状态字段。
export const workflowStateSchema = z
  .object({
    run: z
      .object({
        workflowId: workflowIdentifierSchema,
        workflowVersionId: workflowIdentifierSchema,
        workflowRunId: workflowIdentifierSchema,
        projectId: workflowIdentifierSchema,
      })
      .strict(),
    inputs: runtimeValueMapSchema,
    outputs: nodeOutputMapSchema,
    variables: runtimeValueMapSchema,
    execution: z
      .object({ controlResults: z.record(workflowIdentifierSchema, z.boolean()).optional() })
      .strict(),
  })
  .strict();

export class DuplicateNodeOutputWriteError extends Error {
  readonly code = 'DUPLICATE_NODE_OUTPUT_WRITE';

  constructor(public readonly nodeId: string) {
    super(`节点输出重复写入：${nodeId}`);
    this.name = 'DuplicateNodeOutputWriteError';
  }
}

export function mergeNodeOutputs(current: NodeOutputMap, update: NodeOutputMap): NodeOutputMap {
  for (const nodeId of Object.keys(update)) {
    if (Object.hasOwn(current, nodeId)) throw new DuplicateNodeOutputWriteError(nodeId);
  }
  return { ...current, ...update };
}

// 当前无环单次执行语义：并行 If 按 nodeId 合并，禁止重复写入同一控制结果。
export function mergeWorkflowExecution(
  current: WorkflowExecutionState,
  update: WorkflowExecutionState,
): WorkflowExecutionState {
  if (update.controlResults === undefined) return current;
  for (const nodeId of Object.keys(update.controlResults)) {
    if (Object.hasOwn(current.controlResults ?? {}, nodeId))
      throw new Error('If 内部路由结果重复写入');
  }
  return { controlResults: { ...current.controlResults, ...update.controlResults } };
}

// 普通确定性 DAG 只允许节点输出写入一次。reducer 不推断 step、重试或新 effective output。
export const WorkflowStateAnnotation = Annotation.Root({
  run: Annotation<WorkflowState['run']>(),
  inputs: Annotation<WorkflowState['inputs']>(),
  outputs: Annotation<NodeOutputMap>({ reducer: mergeNodeOutputs, default: () => ({}) }),
  variables: Annotation<WorkflowState['variables']>(),
  execution: Annotation<WorkflowState['execution']>({
    reducer: mergeWorkflowExecution,
    default: () => ({}),
  }),
});
