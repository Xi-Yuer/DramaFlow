import {
  isTypeAssignable,
  workflowOutputSources,
  type RuntimeValue,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import type { WorkflowState } from '../runtime/state.js';

export interface WorkflowOutputResolver {
  resolve(definition: WorkflowDefinition, state: WorkflowState): Record<string, RuntimeValue>;
}

export class WorkflowOutputResolutionError extends Error {
  constructor(
    public readonly code:
      'WORKFLOW_OUTPUT_MISSING' | 'WORKFLOW_OUTPUT_TYPE_MISMATCH' | 'WORKFLOW_OUTPUT_AMBIGUOUS',
    public readonly outputName: string,
  ) {
    super(
      code === 'WORKFLOW_OUTPUT_AMBIGUOUS'
        ? `工作流输出 ${outputName} 存在多个候选来源`
        : `工作流输出 ${outputName} 的来源缺失或类型不匹配`,
    );
    this.name = 'WorkflowOutputResolutionError';
  }
}

export class DefaultWorkflowOutputResolver implements WorkflowOutputResolver {
  resolve(definition: WorkflowDefinition, state: WorkflowState): Record<string, RuntimeValue> {
    return Object.fromEntries(
      definition.outputs.map((output) => {
        const present: RuntimeValue[] = [];
        for (const { nodeId, outputKey } of workflowOutputSources(output)) {
          const nodeOutputs = Object.hasOwn(state.outputs, nodeId)
            ? state.outputs[nodeId]
            : undefined;
          if (nodeOutputs && Object.hasOwn(nodeOutputs, outputKey))
            present.push(nodeOutputs[outputKey]!);
        }
        if (present.length > 1)
          throw new WorkflowOutputResolutionError('WORKFLOW_OUTPUT_AMBIGUOUS', output.name);
        const value = present[0];
        if (value === undefined)
          throw new WorkflowOutputResolutionError('WORKFLOW_OUTPUT_MISSING', output.name);
        if (!isTypeAssignable(value.type, output.type))
          throw new WorkflowOutputResolutionError('WORKFLOW_OUTPUT_TYPE_MISMATCH', output.name);
        return [output.name, value];
      }),
    );
  }
}
