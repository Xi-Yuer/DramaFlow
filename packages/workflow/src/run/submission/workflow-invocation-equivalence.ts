import type { RuntimeValue, WorkflowRun } from '@dramaflow/contracts';
import { areRuntimeValueMapsEqual } from '../../runtime/values/runtime-value-equivalence.js';

export function isWorkflowInvocationEquivalent(
  run: Pick<WorkflowRun, 'workflowId' | 'workflowVersionId' | 'inputs'>,
  invocation: {
    readonly workflowId: string;
    readonly workflowVersionId: string;
    readonly inputs: Readonly<Record<string, RuntimeValue>>;
  },
): boolean {
  return (
    run.workflowId === invocation.workflowId &&
    run.workflowVersionId === invocation.workflowVersionId &&
    areRuntimeValueMapsEqual(run.inputs, invocation.inputs)
  );
}
