import { isTypeAssignable, type RuntimeValue, type WorkflowDefinition } from '@dramaflow/contracts';
import type { WorkflowState } from '../runtime/state.js';

export interface WorkflowOutputResolver {
  resolve(definition: WorkflowDefinition, state: WorkflowState): Record<string, RuntimeValue>;
}

export class WorkflowOutputResolutionError extends Error {
  constructor(
    public readonly code: 'WORKFLOW_OUTPUT_MISSING' | 'WORKFLOW_OUTPUT_TYPE_MISMATCH',
    public readonly outputName: string,
  ) {
    super(`工作流输出 ${outputName} 的来源缺失或类型不匹配`);
    this.name = 'WorkflowOutputResolutionError';
  }
}

export class DefaultWorkflowOutputResolver implements WorkflowOutputResolver {
  resolve(definition: WorkflowDefinition, state: WorkflowState): Record<string, RuntimeValue> {
    return Object.fromEntries(
      definition.outputs.map((output) => {
        const { nodeId, outputKey } = output.source;
        const nodeOutputs = Object.hasOwn(state.outputs, nodeId)
          ? state.outputs[nodeId]
          : undefined;
        const value =
          nodeOutputs && Object.hasOwn(nodeOutputs, outputKey) ? nodeOutputs[outputKey] : undefined;
        if (value === undefined)
          throw new WorkflowOutputResolutionError('WORKFLOW_OUTPUT_MISSING', output.name);
        if (!isTypeAssignable(value.type, output.type))
          throw new WorkflowOutputResolutionError('WORKFLOW_OUTPUT_TYPE_MISMATCH', output.name);
        return [output.name, value];
      }),
    );
  }
}
