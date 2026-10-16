import type {
  InputBinding,
  JsonObject,
  JsonValue,
  NodeResult,
  WorkflowDefinition,
  WorkflowNode,
} from '@dramaflow/contracts';
import { getNodeDefinition } from './catalog.js';

export class WorkflowInputError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowInputError';
  }
}

function readPath(value: JsonValue | undefined, path?: string): JsonValue | undefined {
  if (!path) return value;
  let current: JsonValue | undefined = value;
  for (const key of path.split('.')) {
    if (['__proto__', 'prototype', 'constructor'].includes(key))
      throw new WorkflowInputError('UNSAFE_DATA_PATH', '不允许读取保留字段');
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key))
      return undefined;
    current = Array.isArray(current) ? current[Number(key)] : current[key];
  }
  return current;
}

function resolveBinding(
  binding: InputBinding,
  inputs: JsonObject,
  results: Record<string, NodeResult>,
  selectedMerge: boolean,
): JsonValue | undefined {
  const source = binding.source;
  if (source.kind === 'literal') return source.value;
  if (source.kind === 'input') return readPath(inputs, source.path);
  const result = results[source.nodeId];
  if (result?.status === 'failed' || result?.status === 'blocked') {
    throw new WorkflowInputError('UPSTREAM_FAILED', `输入 ${binding.port} 的上游节点失败`);
  }
  if (result?.status === 'skipped') {
    if (binding.optional || selectedMerge) return undefined;
    throw new WorkflowInputError(
      'INPUT_UNAVAILABLE_FROM_SKIPPED_BRANCH',
      `必需输入 ${binding.port} 来自未激活分支`,
    );
  }
  return readPath(result?.outputs[source.port], source.path);
}

export function resolveNodeInputs(
  node: WorkflowNode,
  definition: WorkflowDefinition,
  inputs: JsonObject,
  results: Record<string, NodeResult>,
): JsonObject {
  const values: JsonObject = {};
  const selectedMerge = node.type === 'merge' && (node.config.mode ?? 'selected') === 'selected';
  for (const binding of definition.bindings.filter((candidate) => candidate.nodeId === node.id)) {
    const value = resolveBinding(binding, inputs, results, selectedMerge);
    if (value === undefined) {
      if (!binding.optional && !selectedMerge)
        throw new WorkflowInputError('INPUT_UNAVAILABLE', `必需输入 ${binding.port} 不存在`);
    } else {
      Object.defineProperty(values, binding.port, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  for (const port of getNodeDefinition(node.type).inputs) {
    const value = values[port.name];
    if (value === undefined && port.required)
      throw new WorkflowInputError('INPUT_UNAVAILABLE', `缺少必需输入 ${port.name}`);
    if (value === undefined) continue;
    const matches =
      port.dataType === 'text'
        ? typeof value === 'string'
        : port.dataType === 'number'
          ? typeof value === 'number'
          : port.dataType === 'boolean'
            ? typeof value === 'boolean'
            : port.dataType === 'array'
              ? Array.isArray(value)
              : true;
    if (!matches)
      throw new WorkflowInputError(
        'INPUT_TYPE_MISMATCH',
        `输入 ${port.name} 需要 ${port.dataType} 类型`,
      );
  }
  return values;
}

export class WorkflowCanceledError extends Error {
  readonly code = 'RUN_CANCELED';
  constructor() {
    super('运行已取消');
    this.name = 'WorkflowCanceledError';
  }
}
