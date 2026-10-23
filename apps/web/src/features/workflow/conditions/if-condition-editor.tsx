'use client';

import { createContext, useContext } from 'react';
import { Button, Input, Select } from 'antd';
import type { ConditionExpression } from '@dramaflow/contracts';
import {
  conditionFromFields,
  conditionToFields,
  ifConditionOperators,
  type IfConditionOperator,
} from './if-condition';
import styles from './if-condition-editor.module.css';

export const WorkflowConditionActions = createContext<{
  disabled: boolean;
  onChange(nodeId: string, condition: ConditionExpression | null): void;
} | null>(null);

export function IfConditionEditor({ nodeId, condition }: { nodeId: string; condition: unknown }) {
  const actions = useContext(WorkflowConditionActions);
  const disabled = !actions || actions.disabled;
  const fields = conditionToFields(condition);
  const unsupported = condition !== undefined && !fields;
  const operatorLabel = ifConditionOperators.find((item) => item.value === fields?.operator)?.label;
  const summary = fields
    ? `value ${operatorLabel} ${JSON.stringify(fields.expected)}`
    : '尚未配置条件';
  return (
    <section className={`nodrag nopan nowheel ${styles.editor}`} aria-label="条件设置">
      <strong>条件</strong>
      {unsupported ? (
        <>
          <p role="status">当前编辑器暂不支持该条件表达式</p>
          <Button
            size="small"
            disabled={disabled}
            onClick={() => actions?.onChange(nodeId, conditionFromFields('equals', ''))}
          >
            替换为可编辑条件
          </Button>
        </>
      ) : (
        <>
          <p className={styles.summary} title={summary}>
            {summary}
          </p>
          <div className={styles.row}>
            <span>value</span>
            <Select<IfConditionOperator>
              aria-label="比较方式"
              size="small"
              placeholder="选择条件"
              value={fields?.operator}
              options={[...ifConditionOperators]}
              disabled={disabled}
              onChange={(operator) =>
                actions?.onChange(nodeId, conditionFromFields(operator, fields?.expected ?? ''))
              }
            />
          </div>
          <Input.TextArea
            aria-label="比较文本"
            placeholder="输入比较文本（允许空字符串）"
            autoSize={{ minRows: 1, maxRows: 4 }}
            value={fields?.expected ?? ''}
            disabled={disabled || !fields}
            onChange={(event) => {
              if (fields)
                actions?.onChange(nodeId, conditionFromFields(fields.operator, event.target.value));
            }}
          />
          <div className={styles.footer}>
            <small>区分大小写，保留空格</small>
            {fields ? (
              <Button
                size="small"
                type="text"
                disabled={disabled}
                onClick={() => actions?.onChange(nodeId, null)}
              >
                清除条件
              </Button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
