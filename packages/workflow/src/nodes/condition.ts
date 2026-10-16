import type { JsonObject, JsonValue, WorkflowNode } from '@dramaflow/contracts';
import { nodeConfigSchemas } from '../catalog.js';
import { WorkflowInputError } from '../inputs.js';

function equalJson(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        equalJson(
          Array.isArray(left) ? left[Number(key)]! : left[key]!,
          Array.isArray(right) ? right[Number(key)]! : right[key]!,
        ),
    )
  );
}

export function evaluateCondition(node: WorkflowNode, input: JsonObject): boolean {
  const config = nodeConfigSchemas.condition.parse(node.config);
  const value = input.value;
  if (value === undefined) throw new WorkflowInputError('INPUT_UNAVAILABLE', '缺少判断输入');
  if (config.operator === 'isTruthy') return Boolean(value);
  const expected = config.expected;
  if (expected === undefined)
    throw new WorkflowInputError('CONDITION_EXPECTED_REQUIRED', '缺少比较值');
  if (config.operator === 'equals') return equalJson(value, expected);
  if (config.operator === 'notEquals') return !equalJson(value, expected);
  if (config.operator === 'contains') {
    if (typeof value === 'string' && typeof expected === 'string') return value.includes(expected);
    if (Array.isArray(value)) return value.some((item) => equalJson(item, expected));
    throw new WorkflowInputError('CONDITION_TYPE_MISMATCH', 'contains 需要字符串或数组输入');
  }
  if (typeof value !== 'number' || typeof expected !== 'number')
    throw new WorkflowInputError('CONDITION_TYPE_MISMATCH', '大小比较需要数值');
  return config.operator === 'greaterThan' ? value > expected : value < expected;
}
