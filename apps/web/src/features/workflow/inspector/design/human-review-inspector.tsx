'use client';

import { useContext } from 'react';
import type { NodeDefinition, NodeTypeManifest } from '@dramaflow/contracts';
import { Textarea } from '@/components/ui/textarea';
import { WorkflowNodeSettingsActions } from '../../node-catalog/human-review-settings';
import { resolveWorkflowNodePorts } from '../../ports/resolve-workflow-node-ports';
import { NodeInputBindingField } from './node-input-binding-field';
import styles from '../workflow-node-inspector.module.css';

export function HumanReviewInspector({
  node,
  manifest,
}: {
  node: NodeDefinition;
  manifest: NodeTypeManifest;
}) {
  const settingsActions = useContext(WorkflowNodeSettingsActions);
  const disabled = !settingsActions || settingsActions.disabled;
  const contentPort = resolveWorkflowNodePorts(node, manifest).inputs.find(
    (port) => port.key === 'content',
  ) ?? {
    key: 'content',
    name: '待审核内容',
    dataType: { kind: 'primitive' as const, name: 'string' as const },
    required: true,
  };
  const instruction = typeof node.config.instruction === 'string' ? node.config.instruction : '';

  return (
    <div className={styles.sections}>
      <section className={styles.section} aria-label="人工审批设置">
        <label className={styles.field}>
          <span className={styles.fieldLabel}>审核说明（可选）</span>
          <Textarea
            aria-label="审核说明"
            rows={2}
            disabled={disabled}
            placeholder="请确认内容是否符合要求"
            value={instruction}
            onChange={(event) =>
              settingsActions?.onConfigChange(
                node.id,
                'instruction',
                event.target.value || undefined,
              )
            }
          />
        </label>
      </section>

      <section className={styles.section} aria-label="输入绑定">
        <NodeInputBindingField
          nodeId={node.id}
          port={contentPort}
          binding={node.inputs[contentPort.key]}
          rows={4}
        />
      </section>
    </div>
  );
}
