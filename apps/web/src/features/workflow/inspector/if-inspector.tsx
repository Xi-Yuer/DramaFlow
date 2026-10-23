'use client';

import { useContext } from 'react';
import type { NodeDefinition, NodeTypeManifest } from '@dramaflow/contracts';
import { Badge } from '@/components/ui/badge';
import { IfConditionEditor } from '../conditions/if-condition-editor';
import { WorkflowInputContext } from '../inputs/workflow-input-context';
import { NodeInputBindingField } from './node-input-binding-field';
import styles from './workflow-node-inspector.module.css';

export function IfInspector({
  node,
  manifest,
}: {
  node: NodeDefinition;
  manifest: NodeTypeManifest;
}) {
  const inputActions = useContext(WorkflowInputContext);
  const valuePort = manifest.inputs.find((port) => port.key === 'value') ?? {
    key: 'value',
    name: '输入值',
    dataType: { kind: 'primitive' as const, name: 'string' as const },
    required: true,
  };
  const controlOutputs = manifest.controlOutputs ?? [];

  return (
    <div className={styles.sections}>
      <section className={styles.section} aria-label="输入绑定">
        <NodeInputBindingField
          nodeId={node.id}
          port={valuePort}
          binding={node.inputs[valuePort.key]}
          rows={2}
        />
      </section>

      <div className={styles.section}>
        <IfConditionEditor nodeId={node.id} condition={node.config.condition} />
      </div>

      {controlOutputs.length > 0 ? (
        <section className={styles.section} aria-label="分支出口">
          <span className={styles.fieldLabel}>分支出口</span>
          <div className={styles.branchList}>
            {controlOutputs.map((branch) => {
              const connectedEdge = inputActions?.definition.edges.find(
                (edge) =>
                  edge.kind === 'control' &&
                  edge.source.nodeId === node.id &&
                  edge.source.portKey === branch.key,
              );
              const targetNode = connectedEdge
                ? inputActions?.definition.nodes.find(
                    (item) => item.id === connectedEdge.target.nodeId,
                  )
                : undefined;
              return (
                <div key={branch.key} className={styles.branchItem}>
                  <div className={styles.branchMeta}>
                    <Badge variant="secondary">{branch.key}</Badge>
                    <span>{branch.name}</span>
                  </div>
                  <span className={styles.branchTarget}>
                    {targetNode ? `→ ${targetNode.name}` : '未连接'}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
