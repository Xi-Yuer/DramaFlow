export type BindingResolutionErrorCode =
  | 'INPUT_SOURCE_CONFLICT'
  | 'SOURCE_NODE_OUTPUT_MISSING'
  | 'WORKFLOW_INPUT_MISSING'
  | 'INPUT_PORT_NOT_FOUND';

export interface BindingResolutionErrorDetails {
  nodeId: string;
  inputKey: string;
  edgeId?: string;
  sourceNodeId?: string;
  sourcePortKey?: string;
  workflowInputKey?: string;
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
