import {
  CancellationRecordingError,
  WorkflowExecutionCancelled,
} from '../execution/cancellation/execution-cancellation.js';
import { isGraphBubbleUp } from '@langchain/langgraph';
import type { NodeRunRepository } from '../execution/node-run-repository.js';
import type { NodeDefinition, NodeRunError } from '@dramaflow/contracts';

const stageCodes = {
  create_run: 'NODE_RUN_CREATION_FAILED',
  resolve_input: 'NODE_INPUT_RESOLUTION_FAILED',
  record_inputs: 'NODE_INPUT_RECORDING_FAILED',
  decode_input: 'NODE_INPUT_DECODE_FAILED',
  validate_input: 'NODE_INPUT_VALIDATION_FAILED',
  validate_config: 'NODE_CONFIG_VALIDATION_FAILED',
  execute: 'NODE_EXECUTION_FAILED',
  validate_output: 'NODE_OUTPUT_VALIDATION_FAILED',
  encode_output: 'NODE_OUTPUT_ENCODING_FAILED',
  complete_run: 'NODE_RUN_COMPLETION_FAILED',
} as const;

export type NodeExecutionStage = keyof typeof stageCodes;
export type NodeExecutionErrorCode = (typeof stageCodes)[NodeExecutionStage];

export class NodeExecutionError extends Error {
  readonly code: NodeExecutionErrorCode;

  constructor(
    public readonly nodeId: string,
    public readonly nodeType: string,
    public readonly stage: NodeExecutionStage,
    cause: unknown,
  ) {
    super(`节点 ${nodeId}（${nodeType}）在 ${stage} 阶段执行失败`, { cause });
    this.name = 'NodeExecutionError';
    this.code = stageCodes[stage];
  }
}

export function toNodeRunError(error: NodeExecutionError): NodeRunError {
  // 不序列化原始 cause、stack 或供应商错误文本，避免携带解码值、URL 和凭证。
  return { code: error.code, stage: error.stage, message: error.message };
}

export class NodeRunRecordingError extends NodeExecutionError {
  constructor(
    public readonly nodeRunId: string,
    error: NodeExecutionError,
    public readonly recordingError: unknown,
  ) {
    super(error.nodeId, error.nodeType, error.stage, error.cause);
    this.name = 'NodeRunRecordingError';
    this.message = `${error.message}；失败记录写入也失败`;
  }
}

export class ChildExecutionRecordingError extends AggregateError {
  constructor(
    public readonly childExecutionId: string,
    public readonly executionError: unknown,
    public readonly recordingError: unknown,
  ) {
    super([executionError, recordingError], '子执行失败，且失败记录写入也失败', {
      cause: executionError,
    });
    this.name = 'ChildExecutionRecordingError';
  }
}

export type GraphExecutionFailure =
  | { kind: 'execution'; executionError: NodeExecutionError }
  | { kind: 'control' | 'cancellation' | 'infrastructure' | 'unknown' };

// 只将已明确标记的执行错误投影为业务失败；未知 throw 不能冒充业务失败。
// Aggregate 保留原对象；控制流、记录故障优先于执行错误，未知成员保守穿透。
export function classifyGraphExecutionFailure(cause: unknown): GraphExecutionFailure {
  const seen = new Set<unknown>();
  const classify = (error: unknown): GraphExecutionFailure => {
    if (error instanceof WorkflowExecutionCancelled) return { kind: 'cancellation' };
    if (error instanceof CancellationRecordingError) return { kind: 'infrastructure' };
    if (error !== null && isGraphBubbleUp(error)) return { kind: 'control' };
    if (error instanceof NodeRunRecordingError || error instanceof ChildExecutionRecordingError)
      return { kind: 'infrastructure' };
    if (seen.has(error)) return { kind: 'unknown' };
    seen.add(error);
    try {
      if (error instanceof NodeExecutionError) {
        const nested = classify(error.cause);
        return nested.kind === 'control' ||
          nested.kind === 'cancellation' ||
          nested.kind === 'infrastructure'
          ? nested
          : { kind: 'execution', executionError: error };
      }
      if (error instanceof AggregateError) {
        const failures = error.errors.map(classify);
        if (failures.some((failure) => failure.kind === 'control')) return { kind: 'control' };
        if (failures.some((failure) => failure.kind === 'infrastructure'))
          return { kind: 'infrastructure' };
        if (failures.some((failure) => failure.kind === 'cancellation'))
          return { kind: 'cancellation' };
        if (failures.some((failure) => failure.kind === 'unknown')) return { kind: 'unknown' };
        return failures.find((failure) => failure.kind === 'execution') ?? { kind: 'unknown' };
      }
      return { kind: 'unknown' };
    } finally {
      seen.delete(error);
    }
  };
  return classify(cause);
}

// Action 与 Human Review 共用失败记录边界，原生图控制流不属于业务失败。
export async function failNodeRun(
  repository: Pick<NodeRunRepository, 'markFailed'>,
  node: NodeDefinition,
  nodeRunId: string,
  stage: NodeExecutionStage,
  cause: unknown,
): Promise<never> {
  const failure = classifyGraphExecutionFailure(cause);
  if (
    failure.kind === 'control' ||
    failure.kind === 'cancellation' ||
    failure.kind === 'infrastructure'
  )
    throw cause;
  const error = new NodeExecutionError(node.id, node.type, stage, cause);
  try {
    await repository.markFailed(nodeRunId, toNodeRunError(error));
  } catch (recordingError) {
    if (recordingError instanceof WorkflowExecutionCancelled) throw recordingError;
    throw new NodeRunRecordingError(nodeRunId, error, recordingError);
  }
  throw error;
}
