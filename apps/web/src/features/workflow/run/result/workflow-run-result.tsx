import { Descriptions, Typography } from 'antd';
import type { RuntimeValue, WorkflowRunResponse } from '@dramaflow/contracts';
import styles from './workflow-run-result.module.css';

function ResultValue({ value }: { value: RuntimeValue }) {
  if (value.storage === 'inline') {
    const content = value.value;
    const isText = typeof content === 'string';
    return (
      <>
        {content === '' ? <Typography.Text type="secondary">空字符串</Typography.Text> : null}
        <pre className={isText ? styles.text : styles.json}>
          {isText ? content : JSON.stringify(content, null, 2)}
        </pre>
      </>
    );
  }

  if (value.storage === 'collection') {
    return <Typography.Text type="secondary">集合值暂不支持展示</Typography.Text>;
  }

  const { type, reference } = value;
  const typeLabel =
    type.kind === 'named' || type.kind === 'primitive' ? type.name : JSON.stringify(type);
  return (
    <>
      <Typography.Text type="secondary">引用结果</Typography.Text>
      <Descriptions size="small" column={1}>
        <Descriptions.Item label="类型">{typeLabel}</Descriptions.Item>
        <Descriptions.Item label="引用类型">{reference.kind}</Descriptions.Item>
        <Descriptions.Item label={reference.kind === 'artifact' ? 'Artifact' : 'ID'}>
          {reference.id}
        </Descriptions.Item>
        {reference.kind === 'asset' ? (
          <Descriptions.Item label="版本">{reference.versionId}</Descriptions.Item>
        ) : null}
      </Descriptions>
      <Typography.Text type="secondary">暂不支持预览</Typography.Text>
    </>
  );
}

export function WorkflowRunResult({ run }: { run: WorkflowRunResponse }) {
  if (run.status !== 'completed') return null;
  const outputs = run.outputs === undefined ? undefined : Object.entries(run.outputs);

  return (
    <section className={styles.panel} aria-label="运行结果">
      <Typography.Title level={5} className={styles.heading}>
        运行结果
      </Typography.Title>
      {outputs === undefined ? (
        <Typography.Text type="secondary">运行结果不可用</Typography.Text>
      ) : outputs.length === 0 ? (
        <Typography.Text type="secondary">此运行没有工作流输出</Typography.Text>
      ) : (
        <div className={styles.outputs} tabIndex={0} aria-label="结果内容">
          {outputs.map(([name, value]) => (
            <article className={styles.output} key={name} aria-label={name}>
              <Typography.Text strong>{name}</Typography.Text>
              <ResultValue value={value} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
