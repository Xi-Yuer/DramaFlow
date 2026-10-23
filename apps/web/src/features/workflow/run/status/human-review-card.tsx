import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import type { HumanReviewActions, HumanReviewState } from './workflow-run-status';
import styles from '../workflow-run.module.css';

// 独立审阅内容承载区，便于未来扩展图片 / 视频 / 长剧本大图审阅工作台（Review Workspace）。
export function HumanReviewContentPreview({ content }: { content: string }) {
  return (
    <ScrollArea className="max-h-56 rounded-lg border border-white/10 bg-[#101012]">
      <div className={styles.reviewContent}>{content}</div>
    </ScrollArea>
  );
}

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
      <Alert variant="warning">
        <div className="flex items-center justify-between gap-2">
          <AlertTitle>等待人工审核</AlertTitle>
          <Badge variant={submitted ? 'secondary' : 'warning'}>
            {submitted ? '已提交' : '待审核'}
          </Badge>
        </div>
        <AlertDescription>
          {submitted
            ? '审批结果已提交，等待工作流继续执行……'
            : review.phase === 'reconciling'
              ? '正在确认服务器审批状态……'
              : '工作流当前暂停，请审核以下内容。'}
        </AlertDescription>
      </Alert>

      <div className="flex items-center justify-between gap-2">
        <strong className="text-xs font-semibold text-foreground">{item.node.name}</strong>
      </div>

      {item.instruction ? (
        <div className={styles.reviewField}>
          <span className="text-xs text-muted-foreground">审核说明</span>
          <div className={styles.reviewText}>{item.instruction}</div>
        </div>
      ) : null}

      <div className={styles.reviewField}>
        <span className="text-xs text-muted-foreground">待审核内容</span>
        <Separator className="my-1" />
        <HumanReviewContentPreview content={item.content} />
      </div>

      <label className={styles.reviewField}>
        <span className="text-xs text-muted-foreground">修改意见 / 反馈（可选）</span>
        <Textarea
          aria-label="修改意见 / 反馈"
          rows={3}
          placeholder="填写修改意见或审核反馈…"
          value={review.feedback}
          disabled={disabled}
          onChange={(event) => actions.onFeedback(item, event.target.value)}
        />
      </label>

      {review.notice ? (
        <Alert variant="info">
          <AlertTitle>{review.notice}</AlertTitle>
        </Alert>
      ) : null}

      <div className={styles.actions}>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || submitting}
          onClick={() => actions.onDecision(item, 'reject')}
        >
          拒绝
        </Button>
        <Button
          variant="default"
          size="sm"
          disabled={disabled || submitting}
          onClick={() => actions.onDecision(item, 'approve')}
        >
          通过
        </Button>
      </div>
    </section>
  );
}
