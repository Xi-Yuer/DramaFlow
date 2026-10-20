const stageCodes = {
  resolve_input: 'NODE_INPUT_RESOLUTION_FAILED',
  decode_input: 'NODE_INPUT_DECODE_FAILED',
  validate_input: 'NODE_INPUT_VALIDATION_FAILED',
  validate_config: 'NODE_CONFIG_VALIDATION_FAILED',
  execute: 'NODE_EXECUTION_FAILED',
  validate_output: 'NODE_OUTPUT_VALIDATION_FAILED',
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
