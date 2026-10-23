import {
  conditionExpressionSchema,
  type ConditionExpression,
  type WorkflowDefinition,
} from '@dramaflow/contracts';

export const ifConditionOperators = [
  { value: 'equals', label: '等于' },
  { value: 'not_equals', label: '不等于' },
  { value: 'contains', label: '包含' },
  { value: 'not_contains', label: '不包含' },
] as const;
export type IfConditionOperator = (typeof ifConditionOperators)[number]['value'];

export function conditionFromFields(
  operator: IfConditionOperator,
  expected: string,
): ConditionExpression {
  switch (operator) {
    case 'equals':
      return { '===': [{ var: 'value' }, expected] };
    case 'not_equals':
      return { '!==': [{ var: 'value' }, expected] };
    case 'contains':
      return { in: [expected, { var: 'value' }] };
    case 'not_contains':
      return { '!': { in: [expected, { var: 'value' }] } };
  }
}

// 只读取当前可编辑子集，不把未来或未知表达式归一化成默认条件。
export function conditionToFields(
  input: unknown,
): { operator: IfConditionOperator; expected: string } | null {
  const parsed = conditionExpressionSchema.safeParse(input);
  if (!parsed.success) return null;
  const expression = parsed.data;
  if ('===' in expression) return { operator: 'equals', expected: expression['==='][1] };
  if ('!==' in expression) return { operator: 'not_equals', expected: expression['!=='][1] };
  if ('in' in expression) return { operator: 'contains', expected: expression.in[0] };
  return { operator: 'not_contains', expected: expression['!'].in[0] };
}

export function setIfCondition(
  definition: WorkflowDefinition,
  nodeId: string,
  condition: ConditionExpression | null,
): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.id !== nodeId || node.type !== 'flow.if' || node.typeVersion !== 1) return node;
      const config = { ...node.config };
      if (condition === null) delete config.condition;
      else config.condition = condition;
      return { ...node, config };
    }),
  };
}
