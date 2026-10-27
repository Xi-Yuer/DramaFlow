import { describe, expect, it } from 'vitest';
import { conditionExpressionSchema, workflowDefinitionSchema } from '@dramaflow/contracts';
import {
  conditionFromFields,
  conditionToFields,
  setIfCondition,
} from '../../../src/features/workflow/conditions/if-condition';
import { ifWorkflow } from '../../fixtures/workflow-if';

describe('If 条件表单与协议往返', () => {
  it.each([
    ['equals', { '===': [{ var: 'value' }, '通过'] }],
    ['not_equals', { '!==': [{ var: 'value' }, '通过'] }],
    ['contains', { in: ['通过', { var: 'value' }] }],
    ['not_contains', { '!': { in: ['通过', { var: 'value' }] } }],
  ] as const)('%s 只生成当前正式协议，往返保留语义', (operator, expression) => {
    expect(conditionFromFields(operator, '通过')).toEqual(expression);
    expect(conditionToFields(expression)).toEqual({ operator, expected: '通过' });
    expect(conditionExpressionSchema.parse(expression)).toEqual(expression);
  });
  it.each(['', ' Approved ', 'APPROVED', '<script>'])('保留原始字符串 %s', (value) => {
    expect(conditionToFields(conditionFromFields('equals', value))?.expected).toBe(value);
  });
  it.each([
    undefined,
    null,
    { var: 'value' },
    { '==': [{ var: 'value' }, 'x'] },
    { in: [{ var: 'value' }, 'x'] },
  ])('未知表达式不擅自解释或改写：%j', (expression) =>
    expect(conditionToFields(expression)).toBeNull(),
  );
  it('condition 是唯一规则来源，更新不影响输入/边/其他节点；未配置条件仍是可保存 Draft', () => {
    const original = ifWorkflow();
    const changed = setIfCondition(original, 'if', conditionFromFields('contains', ' 通过 '));
    const reloaded = workflowDefinitionSchema.parse(JSON.parse(JSON.stringify(changed)));
    expect(conditionToFields(reloaded.nodes[0]!.config.condition)).toEqual({
      operator: 'contains',
      expected: ' 通过 ',
    });
    expect(changed.nodes[0]!.inputs).toEqual({});
    expect(changed.edges).toEqual(original.edges);
    expect(original.nodes[0]!.config).toEqual({});
    expect(
      workflowDefinitionSchema.parse(setIfCondition(changed, 'if', null)).nodes[0]!.config,
    ).toEqual({});
    expect(setIfCondition(original, 'a', conditionFromFields('equals', 'x'))).toEqual(original);
  });
});
