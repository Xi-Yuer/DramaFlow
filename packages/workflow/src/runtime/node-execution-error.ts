import { isGraphBubbleUp } from '@langchain/langgraph';
import type { NodeRunRepository } from '../run/node-run-repository.js';
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

export class IterationItemRunRecordingError extends AggregateError {
  constructor(
    public readonly iterationItemRunId: string,
    public readonly executionError: NodeExecutionError,
    public readonly recordingError: unknown,
  ) {
    super([executionError, recordingError], 'Iteration item 失败，且失败记录写入也失败', {
      cause: executionError,
    });
    this.name = 'IterationItemRunRecordingError';
  }
}

// Action 与 Human Review 共用失败记录边界，原生图控制流不属于业务失败。
export async function failNodeRun(
  repository: Pick<NodeRunRepository, 'markFailed'>,
  node: NodeDefinition,
  nodeRunId: string,
  stage: NodeExecutionStage,
  cause: unknown,
): Promise<never> {
  if (cause !== null && isGraphBubbleUp(cause)) throw cause;
  const error = new NodeExecutionError(node.id, node.type, stage, cause);
  try {
    await repository.markFailed(nodeRunId, toNodeRunError(error));
  } catch (recordingError) {
    throw new NodeRunRecordingError(nodeRunId, error, recordingError);
  }
  throw error;
}
