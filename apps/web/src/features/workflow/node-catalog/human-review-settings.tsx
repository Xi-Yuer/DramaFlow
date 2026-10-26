'use client';

import { createContext, useContext, useState } from 'react';
import { Input } from 'antd';
import styles from '../canvas/rendering/workflow-node.module.css';

export const WorkflowNodeSettingsActions = createContext<{
  disabled: boolean;
  onRename(nodeId: string, name: string): void;
  onConfigChange(nodeId: string, key: string, value: string | undefined): void;
} | null>(null);

export function HumanReviewSettings({
  nodeId,
  name,
  instruction,
}: {
  nodeId: string;
  name: string;
  instruction: unknown;
}) {
  const actions = useContext(WorkflowNodeSettingsActions);
  const [editingName, setEditingName] = useState<string | null>(null);
  const disabled = !actions || actions.disabled;
  function commitName() {
    const value = editingName?.trim();
    if (!disabled && value && value !== name) actions?.onRename(nodeId, value);
    setEditingName(null);
  }
  return (
    <section className={`nodrag nopan nowheel ${styles.inputs}`} aria-label="人工审批设置">
      <label className={styles.selector}>
        <span>节点名称</span>
        <Input
          aria-label="节点名称"
          value={editingName ?? name}
          disabled={disabled}
          onChange={(event) => setEditingName(event.target.value)}
          onBlur={commitName}
          onPressEnter={commitName}
        />
      </label>
      <label className={styles.selector}>
        <span>审核说明（可选）</span>
        <Input.TextArea
          aria-label="审核说明"
          rows={2}
          disabled={disabled}
          placeholder="请确认内容是否符合要求"
          value={typeof instruction === 'string' ? instruction : ''}
          onChange={(event) =>
            actions?.onConfigChange(nodeId, 'instruction', event.target.value || undefined)
          }
        />
      </label>
    </section>
  );
}
