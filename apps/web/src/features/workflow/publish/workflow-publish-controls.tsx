import { Alert, Button, Tooltip } from 'antd';
import type { PublishedWorkflowVersion, WorkflowPublishError } from './workflow-publish';
import { workflowPublishErrorDescription } from './workflow-publish';
import styles from './workflow-publish.module.css';

export function WorkflowPublishControls({
  revision,
  revisionConflict,
  dirty,
  disabledReason,
  publishing,
  current,
  latest,
  error,
  versionsError,
  versionsLoading,
  onPublish,
  onRetryVersions,
  compact = false,
}: {
  compact?: boolean;
  revision: number;
  revisionConflict: boolean;
  dirty: boolean;
  disabledReason: string | null;
  publishing: boolean;
  current: PublishedWorkflowVersion | null;
  latest: PublishedWorkflowVersion | null;
  error: WorkflowPublishError | null;
  versionsError: boolean;
  versionsLoading: boolean;
  onPublish: () => void;
  onRetryVersions: () => void;
}) {
  return (
    <section className={`${styles.panel} ${compact ? styles.compact : ''}`} aria-label="工作流发布">
      <div className={styles.row}>
        <Tooltip title={disabledReason ?? '发布当前已保存的草稿，不会自动保存或运行'}>
          <span>
            <Button
              size="small"
              loading={publishing}
              disabled={disabledReason !== null}
              onClick={onPublish}
            >
              发布
            </Button>
          </span>
        </Tooltip>
        <span className={styles.status} role="status" aria-label="工作流发布状态">
          {publishing
            ? '正在发布…'
            : revisionConflict
              ? '草稿修订冲突，请重新读取服务器草稿'
              : current
                ? `保存修订 ${revision} 已发布 · v${current.version}${dirty ? '，当前修改尚未保存' : ''}`
                : versionsLoading
                  ? '正在读取发布状态…'
                  : versionsError
                    ? '当前修订的发布状态待核对'
                    : `保存修订 ${revision} 尚未发布`}
        </span>
        {latest && (!compact || latest.id !== current?.id) ? (
          <span className={styles.status} title={`发布时间：${latest.publishedAt}`}>
            最新发布 v{latest.version}
            <time dateTime={latest.publishedAt} hidden={compact}>
              {' '}
              ·{' '}
              {new Date(latest.publishedAt).toLocaleString('zh-CN', {
                timeZone: 'Asia/Shanghai',
                hour12: false,
              })}
            </time>
          </span>
        ) : !latest && !versionsLoading && !versionsError ? (
          <span className={styles.status}>暂无已发布版本</span>
        ) : null}
        {disabledReason && !publishing && !compact ? (
          <span className={styles.reason}>{disabledReason}</span>
        ) : null}
      </div>
      {error ? (
        <Alert
          showIcon
          type="error"
          title="上次发布操作未完成"
          description={workflowPublishErrorDescription(error)}
        />
      ) : null}
      {versionsError ? (
        <Alert
          showIcon
          type="warning"
          title="版本列表读取失败"
          description="已确认的发布结果仍保留，请刷新版本状态核对。"
          action={
            <Button
              size="small"
              loading={versionsLoading}
              disabled={publishing}
              onClick={onRetryVersions}
            >
              刷新版本状态
            </Button>
          }
        />
      ) : null}
    </section>
  );
}
