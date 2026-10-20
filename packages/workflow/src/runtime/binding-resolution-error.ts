export type BindingResolutionErrorCode = 'INPUT_SOURCE_CONFLICT' | 'SOURCE_NODE_OUTPUT_MISSING';

export interface BindingResolutionErrorDetails {
  nodeId: string;
  inputKey: string;
  edgeId: string;
  sourceNodeId: string;
  sourcePortKey: string;
}

export class BindingResolutionError extends Error {
  constructor(
    public readonly code: BindingResolutionErrorCode,
    message: string,
    public readonly details: BindingResolutionErrorDetails,
  ) {
    super(message);
    this.name = 'BindingResolutionError';
  }
}
