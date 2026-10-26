'use client';

import { useContext } from 'react';
import type { NodeDefinition, NodeTypeManifest } from '@dramaflow/contracts';
import { ModelSelector } from '../../model-selection/model-selector';
import { WorkflowModelActionsContext } from '../../model-selection/selection/model-selection-context';
import { resolveWorkflowNodePorts } from '../../ports/resolve-workflow-node-ports';
import { NodeInputBindingField } from './node-input-binding-field';
import styles from '../workflow-node-inspector.module.css';

export function TextGenerateInspector({
  node,
  manifest,
}: {
  node: NodeDefinition;
  manifest: NodeTypeManifest;
}) {
  const modelActions = useContext(WorkflowModelActionsContext);
  const modelField = manifest.config.find(
    (field) => field.key === 'modelConfigurationId' || field.ui?.component === 'model-selector',
  );
  const capabilityTypes = (manifest.capabilities ?? []).map((item) => item.type);
  const inputPorts = resolveWorkflowNodePorts(node, manifest).inputs.filter(
    (port) =>
      port.key === 'prompt' || port.key === 'system' || node.inputs[port.key]?.type === 'candidate',
  );

  return (
    <div className={styles.sections}>
      <section className={styles.section} aria-label="模型配置">
        <div className={styles.sectionHeader}>
          <span className={styles.fieldLabel}>{modelField?.name ?? '模型配置'}</span>
        </div>
        {modelActions && capabilityTypes.length > 0 ? (
          <ModelSelector
            nodeId={node.id}
            capabilityTypes={capabilityTypes}
            value={node.config[modelField?.key ?? 'modelConfigurationId']}
          />
        ) : (
          <span>选择模型</span>
        )}
      </section>

      {inputPorts.length > 0 ? (
        <section className={styles.section} aria-label="输入绑定">
          {inputPorts.map((port) => (
            <NodeInputBindingField
              key={port.key}
              nodeId={node.id}
              port={port}
              binding={node.inputs[port.key]}
              rows={port.key === 'system' ? 3 : 4}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}
