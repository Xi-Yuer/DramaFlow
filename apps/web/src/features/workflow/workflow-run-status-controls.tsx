import { Alert, Button, Descriptions, Space, Tag, Typography } from 'antd';
import type { WorkflowRunStatus } from '@dramaflow/contracts';
import type { WorkflowRunStatusState } from './workflow-run-status';
import styles from './workflow-run.module.css';

const statusDisplay: Record<WorkflowRunStatus, { label: string; color: string }> = {
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
}: {
  state: WorkflowRunStatusState;
  onRefresh: () => void;
}) {
  if (state.phase === 'idle') return null;
  const run = state.run;
  return (
    <section className={styles.statusPanel} aria-label="Workflow Run 状态">
      <div className={styles.header}>
        <Space wrap>
          <Typography.Text strong>Run 状态</Typography.Text>
          {run ? (
            <Tag color={statusDisplay[run.status].color}>{statusDisplay[run.status].label}</Tag>
          ) : null}
        </Space>
        <Button
          size="small"
          loading={state.refreshing}
          disabled={state.refreshing}
          onClick={onRefresh}
        >
          手动刷新
        </Button>
      </div>

      {state.phase === 'loading' && !run ? (
        <Typography.Text className={styles.secondary}>
          正在查询 WorkflowRun {state.runId}…
        </Typography.Text>
      ) : null}

      {run ? (
        <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }}>
          <Descriptions.Item label="Run ID">{run.id}</Descriptions.Item>
          <Descriptions.Item label="WorkflowVersion">{run.workflowVersionId}</Descriptions.Item>
          <Descriptions.Item label="invocationKey">{run.invocationKey}</Descriptions.Item>
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
        <Alert
          showIcon
          type="warning"
          title="工作流正在等待外部/人工继续"
          description="本阶段仅展示等待状态，不提供恢复操作。"
        />
      ) : null}

      {run?.status === 'failed' && run.error ? (
        <Alert
          showIcon
          type="error"
          title="工作流运行失败"
          description={
            <Space direction="vertical" size={0}>
              <span>{run.error.message}</span>
              <span>
                阶段：{run.error.stage}
                {run.error.code ? ` · ${run.error.code}` : ''}
              </span>
            </Space>
          }
        />
      ) : null}

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
              disabled={state.refreshing}
              onClick={onRefresh}
            >
              手动刷新
            </Button>
          }
        />
      ) : null}
    </section>
  );
}
