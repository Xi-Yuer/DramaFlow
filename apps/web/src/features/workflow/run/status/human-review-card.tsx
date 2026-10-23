import { Alert, Button, Input, Typography } from 'antd';
import type { HumanReviewActions, HumanReviewState } from './workflow-run-status';
import styles from '../workflow-run.module.css';

export function HumanReviewCard({
  review,
  actions,
  refreshing,
}: {
  review: HumanReviewState;
  actions: HumanReviewActions;
  refreshing: boolean;
}) {
  const { item } = review;
  const submitted = item.submissionStatus === 'submitted';
  const submitting = review.phase === 'submitting';
  const disabled = submitted || review.phase !== 'ready' || refreshing;
  return (
    <section className={styles.reviewCard} aria-label="人工审核">
      <Alert
        showIcon
        type="warning"
        title="等待人工审核"
        description={
          submitted
            ? '审批结果已提交，等待工作流继续执行……'
            : review.phase === 'reconciling'
              ? '正在确认服务器审批状态……'
              : '工作流当前暂停，请审核以下内容。'
        }
      />
      <Typography.Text strong>{item.node.name}</Typography.Text>
      {item.instruction ? (
        <div className={styles.reviewField}>
          <Typography.Text type="secondary">审核说明</Typography.Text>
          <div className={styles.reviewText}>{item.instruction}</div>
        </div>
      ) : null}
      <div className={styles.reviewField}>
        <Typography.Text type="secondary">待审核内容</Typography.Text>
        <div className={styles.reviewContent}>{item.content}</div>
      </div>
      <label className={styles.reviewField}>
        <span>修改意见 / 反馈（可选）</span>
        <Input.TextArea
          aria-label="修改意见 / 反馈"
          rows={3}
          value={review.feedback}
          disabled={disabled}
          onChange={(event) => actions.onFeedback(item, event.target.value)}
        />
      </label>
      {review.notice ? <Alert showIcon type="info" title={review.notice} /> : null}
      <div className={styles.actions}>
        <Button
          disabled={disabled}
          loading={submitting}
          onClick={() => actions.onDecision(item, 'reject')}
        >
          拒绝
        </Button>
        <Button
          type="primary"
          disabled={disabled}
          loading={submitting}
          onClick={() => actions.onDecision(item, 'approve')}
        >
          通过
        </Button>
      </div>
    </section>
  );
}
