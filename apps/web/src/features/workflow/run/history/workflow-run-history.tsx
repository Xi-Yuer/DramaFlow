'use client';
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Alert, Button, Drawer, Empty, Spin, Space, Tag, Typography, theme } from 'antd';
import type { WorkflowRunSummary } from '@dramaflow/contracts';
import { workflowApi, workflowKeys } from '../../workflow-api';
import { workflowRunDisplay, formatWorkflowRunTime } from '../status/workflow-run-status-controls';
import styles from './workflow-run-history.module.css';
import { ApiError } from '../../../../lib/http';

export function WorkflowRunHistory({
  projectId,
  workflowId,
  selectedId,
  onSelect,
}: {
  projectId: string;
  workflowId: string;
  selectedId?: string;
  onSelect(run: WorkflowRunSummary): void;
}) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const history = useInfiniteQuery({
    queryKey: workflowKeys.runHistory(projectId, workflowId),
    enabled: open,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const page = await workflowApi.listRuns(projectId, workflowId, pageParam, signal);
      if (
        page.items.some((run) => run.workflowId !== workflowId) ||
        (page.nextCursor && page.nextCursor === pageParam)
      )
        throw new ApiError('运行历史响应与当前工作流或分页位置不一致', 200);
      return page;
    },
    getNextPageParam: (page, _pages, _cursor, cursors) =>
      page.nextCursor && !cursors.includes(page.nextCursor) ? page.nextCursor : undefined,
  });
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>
        运行历史
      </Button>
      <Drawer title="运行历史" open={open} onClose={() => setOpen(false)} size="default">
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Button
            loading={history.isFetching && !history.isFetchingNextPage}
            onClick={() => void history.refetch()}
          >
            刷新历史
          </Button>
          {history.isError ? (
            <Alert
              title="运行历史读取失败"
              type="error"
              action={<Button onClick={() => void history.refetch()}>重试</Button>}
            />
          ) : null}
          <Spin spinning={history.isPending}>
            {!history.isPending && !history.isError && items.length === 0 ? (
              <Empty description="暂无历史运行" />
            ) : null}
            <ul className={styles.list} aria-label="历史运行列表">
              {items.map((run) => {
                const status = workflowRunDisplay(run);
                return (
                  <li
                    key={run.id}
                    className={styles.row}
                    style={{ borderColor: token.colorBorderSecondary }}
                  >
                    <Space orientation="vertical" size={4} className={styles.details}>
                      <Space>
                        <Tag color={status.color}>{status.label}</Tag>
                        <Typography.Text>
                          {run.version === null ? '版本不可用' : `v${run.version}`}
                        </Typography.Text>
                      </Space>
                      <Typography.Text>{formatWorkflowRunTime(run.createdAt)}</Typography.Text>
                      <Typography.Text type="secondary">
                        {run.startedAt
                          ? `开始：${formatWorkflowRunTime(run.startedAt)}`
                          : '尚未开始'}
                      </Typography.Text>
                      {run.completedAt ? (
                        <Typography.Text type="secondary">
                          结束：{formatWorkflowRunTime(run.completedAt)}
                        </Typography.Text>
                      ) : null}
                      {run.error ? (
                        <Typography.Text type="danger">{run.error.message}</Typography.Text>
                      ) : null}
                      <Typography.Text type="secondary" copyable>
                        {run.id}
                      </Typography.Text>
                    </Space>
                    <Button
                      aria-label={`查看运行 ${run.id}`}
                      onClick={() => {
                        onSelect(run);
                        setOpen(false);
                      }}
                    >
                      {selectedId === run.id ? '当前运行' : '查看'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </Spin>
          {history.hasNextPage ? (
            <Button
              loading={history.isFetchingNextPage}
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              加载更多
            </Button>
          ) : null}
        </Space>
      </Drawer>
    </>
  );
}
