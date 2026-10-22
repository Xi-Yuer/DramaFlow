import type { RuntimeValue, WorkflowRun } from '@dramaflow/contracts';

// 比较已通过 JSON 边界的调用数据：对象键顺序无关，数组顺序及缺失键保持区别。
function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value: unknown, index: number) => jsonEqual(value, right[index]))
    );
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
  );
}

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
    jsonEqual(run.inputs, invocation.inputs)
  );
}
