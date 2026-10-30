'use client';

import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Drawer, Space, Collapse, Spin, Typography } from 'antd';
import type { ProductWorkflowInvocation, WorkflowResponse } from '@dramaflow/contracts';
import { ApiError } from '@/lib/http';
import { WorkflowRunControls } from '@/features/workflow/run/workflow-run-controls';
import { useWorkflowRun } from '@/features/workflow/run/use-workflow-run';
import { InvocationRecoveryControls } from '@/features/workflow/run/recovery/invocation-recovery-controls';
import { useWorkflowRunStatus } from '@/features/workflow/run/status/use-workflow-run-status';
import { WorkflowRunStatusView } from '@/features/workflow/run/status/workflow-run-status-controls';
import { ExecutionTreeBrowser } from '@/features/workflow/run/execution/execution-tree-browser';
import { workflowApi, workflowKeys } from '@/features/workflow/workflow-api';
import { productInvocationApi, productInvocationKeys } from './product-invocation-api';
import styles from '@/features/projects/workspace/workspace.module.css';

export function VideoWorkflowInvocations({
  projectId,
  videoId,
  onUnsafeChange,
}: {
  projectId: string;
  videoId: string;
  onUnsafeChange: (unsafe: boolean) => void;
}) {
  const workflow = useQuery({
    queryKey: workflowKeys.project(projectId),
    queryFn: () => workflowApi.get(projectId),
    retry: false,
  });
  const denied =
    workflow.error instanceof ApiError && [401, 403, 404].includes(workflow.error.status);
  return (
    <section className={styles.card} aria-label="视频工作流调用">
      <h2>工作流调用</h2>
      <p className={styles.description}>选择项目中已发布的版本，为这个视频作品发起运行。</p>
      {workflow.isPending ? (
        <Spin />
      ) : workflow.data && !denied ? (
        <>
          {workflow.error ? (
            <Alert
              type="warning"
              showIcon
              title="工作流信息暂时无法刷新，当前输入仍保留"
              action={<Button onClick={() => void workflow.refetch()}>重试</Button>}
            />
          ) : null}
          <InvocationWorkspace
            key={`${workflow.data.id}:${videoId}`}
            workflow={workflow.data}
            videoId={videoId}
            onUnsafeChange={onUnsafeChange}
          />
        </>
      ) : (
        <Alert
          type={
            workflow.error instanceof ApiError && workflow.error.status === 404 ? 'info' : 'error'
          }
          showIcon
          title={
            workflow.error instanceof ApiError && workflow.error.status === 404
              ? '请先在项目工作流中建立并发布版本'
              : '项目工作流读取失败'
          }
          action={<Button onClick={() => void workflow.refetch()}>重新读取工作流</Button>}
        />
      )}
    </section>
  );
}

function InvocationWorkspace({
  workflow,
  videoId,
  onUnsafeChange,
}: {
  workflow: WorkflowResponse;
  videoId: string;
  onUnsafeChange: (unsafe: boolean) => void;
}) {
  const projectId = workflow.projectId;
  const cache = useQueryClient();
  const options = useMemo(
    () => ({
      callerNamespace: `product-workflow:${videoId}`,
      start: async (input: Parameters<typeof productInvocationApi.start>[2]) => {
        try {
          return (await productInvocationApi.start(projectId, videoId, input)).run;
        } finally {
          void cache.invalidateQueries({
            queryKey: productInvocationKeys.history(projectId, videoId),
          });
        }
      },
      lookup: async (_workflowId: string, key: string) => {
        const { invocation } = await productInvocationApi.lookup(projectId, key);
        if (!invocation) return { run: null };
        if (invocation.sourceVideoId !== videoId)
          throw new ApiError('此次调用不属于当前视频作品', 409);
        return { run: (await productInvocationApi.get(projectId, invocation.id)).run };
      },
    }),
    [cache, projectId, videoId],
  );
  const run = useWorkflowRun(projectId, workflow.id, null, options);
  const unsafe = run.state.phase === 'submitting' || run.uncertainInvocation;
  useEffect(() => {
    onUnsafeChange(unsafe);
  }, [onUnsafeChange, unsafe]);
  useEffect(() => () => onUnsafeChange(false), [onUnsafeChange]);
  const [selected, setSelected] = useState<ProductWorkflowInvocation | null>(null);
  const history = useInfiniteQuery({
    queryKey: productInvocationKeys.history(projectId, videoId),
    queryFn: ({ pageParam }) => productInvocationApi.list(projectId, videoId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return (
    <Space orientation="vertical" style={{ width: '100%' }} size="middle">
      <Typography.Text>{workflow.name}</Typography.Text>
      <InvocationRecoveryControls
        state={run.recovery}
        onRetry={() => void run.retryRecovery()}
        onSelect={run.selectRecovered}
      />
      <WorkflowRunControls
        versions={run.versions}
        selectedVersionId={run.selectedVersionId}
        version={run.version}
        versionsLoading={run.versionsLoading}
        versionLoading={run.versionLoading}
        versionsError={run.versionsError}
        versionError={run.versionError}
        draftDirty={false}
        values={run.values}
        state={run.state}
        runStatus={run.runStatus}
        onSelectVersion={run.selectVersion}
        onChangeInput={run.changeInput}
        onRun={() => void run.run()}
        onRetry={() => void run.retry()}
        onRetryVersions={() => void run.retryVersions()}
        onRetryVersion={() => void run.retryVersion()}
        onRefreshRunStatus={run.refreshRunStatus}
        submissionDisabled={run.recovery.checking || run.recovery.storageError}
        reviewActions={run.reviewActions}
        onCancelRun={run.cancelRun}
      />
      <h3>调用记录</h3>
      {history.isPending ? (
        <Spin />
      ) : history.error ? (
        <Alert
          type="error"
          title="调用记录读取失败"
          showIcon
          action={<Button onClick={() => void history.refetch()}>重试</Button>}
        />
      ) : history.data.pages.flatMap((page) => page.items).length === 0 ? (
        <p className={styles.description}>尚未从这个视频发起工作流调用。</p>
      ) : (
        history.data.pages
          .flatMap((page) => page.items)
          .map((invocation) => (
            <div key={invocation.id}>
              <Space wrap>
                <time>{new Date(invocation.createdAt).toLocaleString('zh-CN')}</time>
                <Button onClick={() => setSelected(invocation)}>查看运行与执行树</Button>
              </Space>
            </div>
          ))
      )}
      {history.hasNextPage ? (
        <Button loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
          加载更多调用
        </Button>
      ) : null}
      <Drawer
        title="视频工作流调用"
        open={!!selected}
        onClose={() => setSelected(null)}
        size="large"
        destroyOnHidden
      >
        {selected ? <InvocationDetails invocation={selected} /> : null}
      </Drawer>
    </Space>
  );
}

function InvocationDetails({ invocation }: { invocation: ProductWorkflowInvocation }) {
  const detail = useQuery({
    queryKey: ['product-invocation', invocation.projectId, invocation.id],
    queryFn: () => productInvocationApi.get(invocation.projectId, invocation.id),
    retry: false,
  });
  if (detail.isPending) return <Spin />;
  if (detail.error || !detail.data) return <Alert type="error" showIcon title="调用读取失败" />;
  return <RunDetails invocation={detail.data.invocation} workflowId={detail.data.run.workflowId} />;
}

function RunDetails({
  invocation,
  workflowId,
}: {
  invocation: ProductWorkflowInvocation;
  workflowId: string;
}) {
  const status = useWorkflowRunStatus(invocation.workflowRunId, {
    projectId: invocation.projectId,
    workflowId,
  });
  return (
    <Space orientation="vertical" style={{ width: '100%' }} size="middle">
      <Typography.Text>来源作品：{invocation.sourceVideoName}</Typography.Text>
      <Typography.Text copyable>调用 ID：{invocation.id}</Typography.Text>
      <Typography.Text copyable>Run ID：{invocation.workflowRunId}</Typography.Text>
      <WorkflowRunStatusView
        state={status.state}
        onRefresh={status.refresh}
        reviewActions={status.reviewActions}
        onCancel={status.cancel}
      />
      <Collapse
        items={[
          {
            key: 'tree',
            label: '执行树',
            children: <ExecutionTreeBrowser runId={invocation.workflowRunId} />,
          },
        ]}
      />
    </Space>
  );
}
