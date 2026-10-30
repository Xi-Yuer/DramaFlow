'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Empty, Form, Input, Modal, Space, Spin, Typography } from 'antd';
import type { WorkflowSummary } from '@dramaflow/contracts';
import { createWorkflowRequestSchema } from '@dramaflow/contracts';
import { workflowApi, workflowKeys } from '../workflow-api';
import { WorkspaceLink } from '@/features/projects/workspace/workspace-link';
import { useProjectNavigationGuard } from '@/features/projects/workspace/workspace-context';
import { useLeaveGuard } from '@/lib/navigation/use-leave-guard';
import styles from '@/features/projects/workspace/workspace.module.css';

export function WorkflowCollection({ projectId }: { projectId: string }) {
  const { modal, message } = App.useApp();
  const cache = useQueryClient();
  const router = useRouter();
  const [dialog, setDialog] = useState<{ workflow?: WorkflowSummary } | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const list = useInfiniteQuery({
    queryKey: workflowKeys.list(projectId),
    queryFn: ({ pageParam }) => workflowApi.list(projectId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const refresh = () => cache.invalidateQueries({ queryKey: workflowKeys.list(projectId) });
  const save = useMutation({
    mutationFn: async () => {
      const input = createWorkflowRequestSchema.parse({ name });
      if (dialog?.workflow) {
        await workflowApi.saveMetadata(projectId, dialog.workflow.id, {
          name: input.name,
          expectedMetadataRevision: dialog.workflow.metadataRevision,
        });
        return null;
      }
      return workflowApi.create(projectId, input.name);
    },
    onSuccess: (created) => {
      setDialog(null);
      void refresh();
      if (created) router.push(`/projects/${projectId}/workflows/${created.id}`);
    },
    onError: () => {
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (workflow: WorkflowSummary) =>
      workflowApi.remove(projectId, workflow.id, {
        expectedRevision: workflow.revision,
        expectedMetadataRevision: workflow.metadataRevision,
      }),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: (cause) => {
      setError(cause.message);
      void message.error(cause.message);
      void refresh();
    },
  });
  const { requestLeave } = useLeaveGuard(
    (!!dialog && (name !== (dialog.workflow?.name ?? '') || save.isPending)) || remove.isPending,
    '确认离开工作流管理？',
  );
  useProjectNavigationGuard(requestLeave);
  function open(workflow?: WorkflowSummary) {
    save.reset();
    setName(workflow?.name ?? '');
    setDialog({ workflow });
  }
  function confirmRemove(workflow: WorkflowSummary) {
    modal.confirm({
      title: `删除「${workflow.name}」？`,
      content: '只允许永久删除尚未发布、没有运行历史的工作流。已有版本、运行和产物会受到保护。',
      okText: '删除工作流',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => remove.mutateAsync(workflow),
    });
  }
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <h1>工作流</h1>
        <p>为项目创建独立工作流，每个工作流拥有自己的草稿、发布版本和运行。</p>
        <Button type="primary" onClick={() => open()}>
          新建工作流
        </Button>
      </div>
      {error ? (
        <Alert
          type="error"
          showIcon
          title="工作流删除未完成"
          description={error}
          closable
          onClose={() => setError(null)}
        />
      ) : null}
      {list.isPending ? (
        <Spin />
      ) : list.error ? (
        <Alert
          type="error"
          showIcon
          title="工作流列表读取失败"
          action={<Button onClick={() => void list.refetch()}>重试</Button>}
        />
      ) : items.length === 0 ? (
        <Empty description="项目还没有工作流">
          <Button onClick={() => open()}>创建第一个工作流</Button>
        </Empty>
      ) : (
        <Space orientation="vertical" style={{ width: '100%' }}>
          {items.map((workflow) => (
            <Card
              key={workflow.id}
              title={
                <WorkspaceLink href={`/projects/${projectId}/workflows/${workflow.id}`}>
                  {workflow.name}
                </WorkspaceLink>
              }
              extra={
                <Space>
                  <Button onClick={() => open(workflow)}>改名</Button>
                  <Button
                    danger
                    disabled={remove.isPending}
                    onClick={() => confirmRemove(workflow)}
                  >
                    删除
                  </Button>
                </Space>
              }
            >
              <Typography.Text type="secondary" copyable>
                {workflow.id}
              </Typography.Text>
              <p>
                草稿修订 {workflow.revision} · 创建于{' '}
                {new Date(workflow.createdAt).toLocaleString('zh-CN')}
              </p>
            </Card>
          ))}
        </Space>
      )}
      {list.hasNextPage ? (
        <Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          加载更多工作流
        </Button>
      ) : null}
      <Modal
        title={dialog?.workflow ? '工作流改名' : '新建工作流'}
        open={!!dialog}
        onCancel={() => requestLeave(() => setDialog(null))}
        footer={null}
        destroyOnHidden
      >
        {save.error ? (
          <Alert type="error" showIcon title="工作流操作未完成" description={save.error.message} />
        ) : null}
        <Form layout="vertical" onFinish={() => save.mutate()}>
          <Form.Item label="工作流名称" htmlFor="workflow-name" required>
            <Input
              id="workflow-name"
              value={name}
              maxLength={80}
              disabled={save.isPending}
              onChange={(event) => setName(event.target.value)}
            />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            loading={save.isPending}
            disabled={!name.trim() || (!!dialog?.workflow && name.trim() === dialog.workflow.name)}
          >
            {dialog?.workflow ? '保存工作流名称' : '创建并进入画布'}
          </Button>
        </Form>
      </Modal>
    </main>
  );
}
