'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Drawer, Space, Collapse, Spin, Typography, Select } from 'antd';
import type { ProductWorkflowInvocation, WorkflowSummary } from '@dramaflow/contracts';
import { ApiError } from '@/lib/http';
import { WorkflowRunControls } from '@/features/workflow/run/workflow-run-controls';
import { useWorkflowRun } from '@/features/workflow/run/use-workflow-run';
import { InvocationRecoveryControls } from '@/features/workflow/run/recovery/invocation-recovery-controls';
import { useWorkflowRunStatus } from '@/features/workflow/run/status/use-workflow-run-status';
import { WorkflowRunStatusView } from '@/features/workflow/run/status/workflow-run-status-controls';
import { ExecutionTreeBrowser } from '@/features/workflow/run/execution/execution-tree-browser';
import { workflowApi, workflowKeys } from '@/features/workflow/workflow-api';
import { productInvocationApi, productInvocationKeys } from './product-invocation-api';
import { useLeaveGuard } from '@/lib/navigation/use-leave-guard';
import styles from '@/features/projects/workspace/workspace.module.css';

export function VideoWorkflowInvocations({
  projectId,
  videoId,
  onUnsafeChange,
  selectedWorkflowId,
}: {
  projectId: string;
  videoId: string;
  onUnsafeChange: (unsafe: boolean) => void;
  selectedWorkflowId?: string;
}) {
  const router = useRouter();
  const address = selectedWorkflowId ?? null;
  const [selection, setSelection] = useState({ address, id: address });
  // URL 改变时同步选择；用户操作先更新本地视图，路由确认同一 ID 不重建运行会话。
  if (selection.address !== address) setSelection({ address, id: address });
  const workflowId = selection.address === address ? selection.id : address;
  const [unsafe, setUnsafe] = useState(false);
  const unsafeChanged = useCallback(
    (value: boolean) => {
      setUnsafe(value);
      onUnsafeChange(value);
    },
    [onUnsafeChange],
  );
  const { requestLeave } = useLeaveGuard(
    unsafe,
    '确认切换工作流？',
    '当前调用尚未确认，切换后仍可通过原工作流的调用记录查询。',
  );
  const workflows = useInfiniteQuery({
    queryKey: workflowKeys.list(projectId),
    queryFn: ({ pageParam }) => workflowApi.list(projectId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  const items = workflows.data?.pages.flatMap((page) => page.items) ?? [];
  const denied =
    workflows.error instanceof ApiError && [401, 403, 404].includes(workflows.error.status);
  const listed = items.find((item) => item.id === workflowId);
  const restored = useQuery({
    queryKey: workflowKeys.detail(projectId, workflowId ?? 'unselected'),
    enabled: !!workflowId && !listed && !workflows.isPending && !denied,
    retry: false,
    queryFn: async () => {
      if (!workflowId) throw new ApiError('尚未选择工作流', 400);
      const result = await workflowApi.get(projectId, workflowId);
      if (result.id !== workflowId || result.projectId !== projectId)
        throw new ApiError('所选工作流身份不匹配', 200);
      return result;
    },
  });
  const restoredDenied =
    restored.error instanceof ApiError && [401, 403, 404].includes(restored.error.status);
  const selected = listed ?? (restoredDenied ? undefined : restored.data);
  const options = selected && !listed ? [...items, selected] : items;
  return (
    <section className={styles.card} aria-label="视频工作流调用">
      <h2>工作流调用</h2>
      <p className={styles.description}>选择项目中的工作流和已发布版本，为这个视频作品发起运行。</p>
      {workflows.isPending ? (
        <Spin />
      ) : denied || !workflows.data ? (
        <Alert
          type="error"
          showIcon
          title="项目工作流读取失败"
          action={<Button onClick={() => void workflows.refetch()}>重新读取工作流</Button>}
        />
      ) : (
        <>
          {workflows.error ? (
            <Alert
              type="warning"
              showIcon
              title="工作流信息暂时无法刷新，当前输入仍保留"
              action={<Button onClick={() => void workflows.refetch()}>重试</Button>}
            />
          ) : null}
          {!listed && restored.error ? (
            <Alert type="error" showIcon title="所选工作流不可用，请重新选择" />
          ) : null}
          {options.length === 0 ? (
            <Alert type="info" showIcon title="项目还没有工作流，请先创建并发布版本" />
          ) : (
            <Select
              aria-label="选择工作流"
              placeholder="选择工作流"
              style={{ width: '100%' }}
              value={selected?.id}
              options={options.map((workflow) => ({
                value: workflow.id,
                label: `${workflow.name} · ${workflow.id.slice(0, 8)}`,
              }))}
              onChange={(id: string) =>
                requestLeave(() => {
                  setSelection({ address, id });
                  router.replace(
                    `/projects/${projectId}/videos/${videoId}?workflowId=${encodeURIComponent(id)}`,
                    { scroll: false },
                  );
                })
              }
            />
          )}
          {workflows.hasNextPage ? (
            <Button
              loading={workflows.isFetchingNextPage}
              onClick={() => void workflows.fetchNextPage()}
            >
              加载更多工作流
            </Button>
          ) : null}
          {selected ? (
            <InvocationWorkspace
              key={`${selected.id}:${videoId}`}
              workflow={selected}
              videoId={videoId}
              onUnsafeChange={unsafeChanged}
            />
          ) : null}
        </>
      )}
      <InvocationHistory projectId={projectId} videoId={videoId} />
    </section>
  );
}

function InvocationWorkspace({
  workflow,
  videoId,
  onUnsafeChange,
}: {
  workflow: WorkflowSummary;
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
    </Space>
  );
}

function InvocationHistory({ projectId, videoId }: { projectId: string; videoId: string }) {
  const [selected, setSelected] = useState<ProductWorkflowInvocation | null>(null);
  const history = useInfiniteQuery({
    queryKey: productInvocationKeys.history(projectId, videoId),
    queryFn: ({ pageParam }) => productInvocationApi.list(projectId, videoId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return (
    <Space orientation="vertical" style={{ width: '100%' }} size="middle">
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
      <Typography.Text copyable>Workflow ID：{workflowId}</Typography.Text>
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
