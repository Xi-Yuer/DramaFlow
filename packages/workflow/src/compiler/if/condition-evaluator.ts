import { conditionExpressionSchema } from '@dramaflow/contracts';
import { LogicEngine, defaultMethods } from 'json-logic-engine';

// 第三方引擎是此边界的内部实现；不导出引擎实例或 operator 注册入口。
const engine = new LogicEngine(
  {
    '===': defaultMethods['==='],
    '!==': defaultMethods['!=='],
    in: defaultMethods.in,
    '!': defaultMethods['!'],
    var: defaultMethods.var,
  },
  { disableInterpretedOptimization: true, disableInline: true },
);

type ConditionErrorCode =
  | 'CONDITION_EXPRESSION_INVALID'
  | 'CONDITION_VALUES_INVALID'
  | 'CONDITION_RESULT_INVALID'
  | 'CONDITION_EVALUATION_FAILED';
export class ConditionEvaluationError extends Error {
  readonly code: ConditionErrorCode;
  constructor(code: ConditionErrorCode) {
    super('条件求值失败');
    this.name = 'ConditionEvaluationError';
    this.code = code;
  }
}

function stringValue(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ConditionEvaluationError('CONDITION_VALUES_INVALID');
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new ConditionEvaluationError('CONDITION_VALUES_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const descriptor = descriptors.value;
  if (
    Reflect.ownKeys(descriptors).length !== 1 ||
    !descriptor ||
    !('value' in descriptor) ||
    !descriptor.enumerable ||
    typeof descriptor.value !== 'string'
  ) {
    throw new ConditionEvaluationError('CONDITION_VALUES_INVALID');
  }
  return descriptor.value;
}

// 对未信任调用重新校验；第三方只收到已解析表达式与新建的 { value }。
// 缺失和类型错误在解释执行之前拒绝，不能依赖 JSON Logic 的 null / missing 规则。
export function evaluateCondition(expression: unknown, values: unknown): boolean {
  const parsed = conditionExpressionSchema.safeParse(expression);
  if (!parsed.success) throw new ConditionEvaluationError('CONDITION_EXPRESSION_INVALID');
  const value = stringValue(values);
  let result: unknown;
  try {
    result = engine.run(parsed.data, { value });
  } catch {
    // 不携带原始异常、条件内容或输入，不自动重试。
    throw new ConditionEvaluationError('CONDITION_EVALUATION_FAILED');
  }
  if (typeof result !== 'boolean') throw new ConditionEvaluationError('CONDITION_RESULT_INVALID');
  return result;
}
