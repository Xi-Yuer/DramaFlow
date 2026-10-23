import { Alert, Button, Collapse, Descriptions, Space, Tag, Typography } from 'antd';
import type { WorkflowRunStatus } from '@dramaflow/contracts';
import { HumanReviewCard } from './human-review-card';
import type { HumanReviewActions, WorkflowRunStatusState } from './workflow-run-status';
import { WorkflowRunResult } from '../result/workflow-run-result';
import styles from '../workflow-run.module.css';

export const workflowRunStatusDisplay: Record<WorkflowRunStatus, { label: string; color: string }> =
  {
    pending: { label: '等待执行', color: 'default' },
    running: { label: '运行中', color: 'processing' },
    waiting: { label: '等待继续', color: 'warning' },
    completed: { label: '已完成', color: 'success' },
    failed: { label: '失败', color: 'error' },
    cancelled: { label: '已取消', color: 'default' },
  };

function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

export function WorkflowRunStatusView({
  state,
  onRefresh,
  reviewActions,
}: {
  state: WorkflowRunStatusState;
  onRefresh: () => void;
  reviewActions?: HumanReviewActions;
}) {
  if (state.phase === 'idle') return null;
  const run = state.run;
  return (
    <section className={styles.statusPanel} aria-label="Workflow Run 状态">
      <div className={styles.header}>
        <Space wrap>
          <Typography.Text strong>运行状态</Typography.Text>
          {run ? (
            <Tag color={workflowRunStatusDisplay[run.status].color}>
              {workflowRunStatusDisplay[run.status].label}
            </Tag>
          ) : null}
        </Space>
        <Button
          size="small"
          loading={state.refreshing}
          disabled={state.refreshing || state.review?.phase === 'submitting'}
          onClick={onRefresh}
        >
          手动刷新
        </Button>
      </div>

      {state.phase === 'loading' && !run ? (
        <Typography.Text className={styles.secondary}>正在读取运行状态…</Typography.Text>
      ) : null}

      {run ? (
        <Descriptions size="small" column={1}>
          <Descriptions.Item label="创建时间">
            <time dateTime={run.createdAt}>{formatTime(run.createdAt)}</time>
          </Descriptions.Item>
          {run.startedAt ? (
            <Descriptions.Item label="开始时间">
              <time dateTime={run.startedAt}>{formatTime(run.startedAt)}</time>
            </Descriptions.Item>
          ) : null}
          {run.completedAt ? (
            <Descriptions.Item label="结束时间">
              <time dateTime={run.completedAt}>{formatTime(run.completedAt)}</time>
            </Descriptions.Item>
          ) : null}
        </Descriptions>
      ) : null}

      {run?.status === 'waiting' ? (
        state.review && reviewActions ? (
          <HumanReviewCard
            review={state.review}
            actions={reviewActions}
            refreshing={state.refreshing}
          />
        ) : (
          <Alert
            showIcon
            type="warning"
            title="工作流正在等待继续"
            description={
              state.refreshing
                ? '正在读取待审批内容…'
                : state.error
                  ? '待审批状态未确认，请手动刷新。'
                  : '当前没有可处理的人工审核，正在确认运行状态。'
            }
          />
        )
      ) : null}

      {run?.status === 'failed' && run.error ? (
        <Alert
          showIcon
          type="error"
          title="工作流运行失败"
          description={
            <Space orientation="vertical" size={0}>
              <span>{run.error.message}</span>
              <span>
                阶段：{run.error.stage}
                {run.error.code ? ` · ${run.error.code}` : ''}
              </span>
            </Space>
          }
        />
      ) : null}

      {run ? <WorkflowRunResult run={run} /> : null}

      {state.phase === 'error' && state.error ? (
        <Alert
          showIcon
          type="error"
          title="运行状态读取失败"
          description={state.error.message}
          action={
            <Button
              size="small"
              loading={state.refreshing}
              disabled={state.refreshing || state.review?.phase === 'submitting'}
              onClick={onRefresh}
            >
              手动刷新
            </Button>
          }
        />
      ) : null}
      {run ? (
        <Collapse
          size="small"
          ghost
          items={[
            {
              key: 'identity',
              label: '运行详情',
              children: (
                <Descriptions size="small" column={1}>
                  <Descriptions.Item label="Run ID">{run.id}</Descriptions.Item>
                  <Descriptions.Item label="WorkflowVersion">
                    {run.workflowVersionId}
                  </Descriptions.Item>
                  <Descriptions.Item label="invocationKey">{run.invocationKey}</Descriptions.Item>
                </Descriptions>
              ),
            },
          ]}
        />
      ) : null}
    </section>
  );
}
