import type { RuntimeValue } from '@dramaflow/contracts';
import styles from '../workflow-node-inspector.module.css';

export function NodeRuntimeValueView({ value }: { value: RuntimeValue }) {
  if (value.storage === 'inline') {
    const content = value.value;
    const isText = typeof content === 'string';
    return (
      <>
        {content === '' ? <span className="text-xs text-muted-foreground"></span> : null}
        <pre className={isText ? styles.valueText : styles.valueJson}>
          {isText ? content || '无内容' : JSON.stringify(content, null, 2)}
        </pre>
      </>
    );
  }

  if (value.storage === 'collection') {
    return <span className="text-muted-foreground">集合值暂不支持展示</span>;
  }

  const { type, reference } = value;
  const typeLabel =
    type.kind === 'named' || type.kind === 'primitive' ? type.name : JSON.stringify(type);

  return (
    <dl className={styles.configList}>
      <div className={styles.configRow}>
        <dt>存储方式</dt>
        <dd>引用结果</dd>
      </div>
      <div className={styles.configRow}>
        <dt>类型</dt>
        <dd>{typeLabel}</dd>
      </div>
      <div className={styles.configRow}>
        <dt>引用类型</dt>
        <dd>{reference.kind}</dd>
      </div>
      <div className={styles.configRow}>
        <dt>{reference.kind === 'artifact' ? 'Artifact' : 'ID'}</dt>
        <dd>{reference.id}</dd>
      </div>
      {reference.kind === 'asset' ? (
        <div className={styles.configRow}>
          <dt>版本</dt>
          <dd>{reference.versionId}</dd>
        </div>
      ) : null}
    </dl>
  );
}
