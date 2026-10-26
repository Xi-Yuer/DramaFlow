import { z } from 'zod';

// 仅约束条件表达式的静态开销，不是 Workflow 执行预算或产品容量限制。
export const CONDITION_EXPRESSION_MAX_DEPTH = 8;
export const CONDITION_EXPRESSION_MAX_NODES = 32;

function jsonLimitIssue(input: unknown): string | undefined {
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  const notJson = '条件表达式必须是纯 JSON 数据';
  function visit(value: unknown, depth: number): string | undefined {
    if (depth > CONDITION_EXPRESSION_MAX_DEPTH) return '条件表达式超过最大嵌套深度';
    if (++nodes > CONDITION_EXPRESSION_MAX_NODES) return '条件表达式超过最大节点数量';
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') return Number.isFinite(value) ? undefined : notJson;
    if (typeof value !== 'object') return notJson;
    if (ancestors.has(value)) return notJson;
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      return notJson;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    // 数组必须稠密且无额外属性；不读取 getter，也不调用 toJSON。
    if (array && keys.length !== descriptors.length?.value + 1) return notJson;
    if (keys.length - (array ? 1 : 0) + nodes > CONDITION_EXPRESSION_MAX_NODES)
      return '条件表达式超过最大节点数量';
    ancestors.add(value);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return notJson;
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return notJson;
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) return notJson;
      const issue = visit(descriptor.value, depth + 1);
      if (issue) return issue;
    }
    ancestors.delete(value);
  }
  return visit(input, 1);
}

const valueVariable = z.object({ var: z.literal('value') }).strict();
const contains = z.object({ in: z.tuple([z.string(), valueVariable]) }).strict();
const stringPredicate = z.union([
  z.object({ '===': z.tuple([valueVariable, z.string()]) }).strict(),
  z.object({ '!==': z.tuple([valueVariable, z.string()]) }).strict(),
  contains,
  // 否定只开放 not_contains，不允许自由嵌套 ! 或组合条件。
  z.object({ '!': contains }).strict(),
]);

// 先做有界 JSON 检查，再进入结构校验，避免循环或极深输入触发递归解析。
export const conditionExpressionSchema = z
  .unknown()
  .superRefine((input, context) => {
    const issue = jsonLimitIssue(input);
    if (issue) context.addIssue({ code: 'custom', message: issue });
  })
  .pipe(stringPredicate);

export type ConditionExpression = z.infer<typeof conditionExpressionSchema>;
