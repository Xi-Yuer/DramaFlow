import type { CandidateBinding, NodeTypeManifest, WorkflowDefinition } from '@dramaflow/contracts';
import { describeNodeOutput, sourceLabel } from './template-input';
import styles from './template-input-editor.module.css';

export function CandidateInputSummary({
  portName,
  binding,
  definition,
  manifests,
}: {
  portName: string;
  binding: CandidateBinding;
  definition: Pick<WorkflowDefinition, 'nodes'>;
  manifests: readonly NodeTypeManifest[];
}) {
  return (
    <div
      className={`nodrag nopan nowheel ${styles.editor}`}
      role="group"
      aria-label={`${portName}候选输入`}
    >
      <span className={styles.label}>{portName} · 候选输入</span>
      {binding.sources.map((source) => {
        const label = describeNodeOutput(definition, manifests, source);
        return (
          <span key={JSON.stringify([source.nodeId, source.portKey])} className={styles.locked}>
            {sourceLabel(label.nodeName, label.portName)}
          </span>
        );
      })}
      <p className={styles.locked}>使用实际执行分支产生的那个值。删除画布连线可移除对应来源。</p>
      {binding.sources.length < 2 ? (
        <p className={styles.locked} role="status">
          候选来源不足，请补齐两个来源后发布。
        </p>
      ) : null}
    </div>
  );
}
