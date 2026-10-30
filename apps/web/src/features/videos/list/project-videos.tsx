'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Empty, Form, Input, Modal, Spin } from 'antd';
import { Film, Plus } from 'lucide-react';
import { createVideoSchema } from '@dramaflow/contracts';
import {
  useProjectNavigationGuard,
  useProjectWorkspace,
} from '@/features/projects/workspace/workspace-context';
import { WorkspaceLink } from '@/features/projects/workspace/workspace-link';
import { useLeaveGuard } from '@/lib/navigation/use-leave-guard';
import { videoApi, videoKeys } from '../api/video-api';
import { VideoStatusTag } from '../presentation/video-status';
import workspace from '@/features/projects/workspace/workspace.module.css';
import styles from '../videos.module.css';

export function ProjectVideos() {
  const { project } = useProjectWorkspace();
  const router = useRouter();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ name: string }>();
  const name = Form.useWatch('name', form);
  const videos = useInfiniteQuery({
    queryKey: videoKeys.list(project.id),
    queryFn: ({ pageParam }) => videoApi.list(project.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const create = useMutation({
    mutationFn: (value: string) => videoApi.create(project.id, value),
    retry: false,
  });
  const { requestLeave } = useLeaveGuard(
    create.isPending || (open && !!name?.trim()),
    '确认离开视频列表？',
    '未提交的视频名称或尚未确认的创建操作只保留在当前页面。',
  );
  useProjectNavigationGuard(requestLeave);
  const items = videos.data?.pages.flatMap((page) => page.items) ?? [];
  function openCreate() {
    form.resetFields();
    create.reset();
    setOpen(true);
  }

  return (
    <main className={workspace.page}>
      <div className={styles.heading}>
        <div className={workspace.heading}>
          <h1>视频</h1>
          <p>为「{project.name}」建立视频作品，先从一个名称开始。</p>
        </div>
        <Button type="primary" icon={<Plus size={16} />} onClick={openCreate}>
          新建视频
        </Button>
      </div>
      {videos.isPending ? (
        <div className={styles.loading} role="status">
          <Spin />
          <span>正在读取视频作品…</span>
        </div>
      ) : videos.error && !videos.data ? (
        <Alert
          type="error"
          showIcon
          title="视频列表读取失败"
          description={videos.error.message}
          action={<Button onClick={() => void videos.refetch()}>重试</Button>}
        />
      ) : (
        <>
          {videos.error ? (
            <Alert
              type="warning"
              showIcon
              title="视频列表暂时无法刷新"
              action={<Button onClick={() => void videos.refetch()}>重试</Button>}
            />
          ) : null}
          {items.length === 0 ? (
            <div className={workspace.empty}>
              <Empty
                image={<Film size={48} aria-hidden />}
                styles={{ image: { height: 48, color: 'var(--muted)' } }}
                description={
                  <>
                    <p>还没有视频作品</p>
                    <span className={workspace.description}>
                      创建第一个视频作品，之后可以继续完善它。现在无需工作流运行或视频文件。
                    </span>
                  </>
                }
              >
                <Button onClick={openCreate}>创建第一个视频</Button>
              </Empty>
            </div>
          ) : (
            <div className={styles.grid}>
              {items.map((video) => (
                <article className={workspace.card} key={video.id}>
                  <VideoStatusTag status={video.status} />
                  <h2 className={styles.name}>
                    <WorkspaceLink href={`/projects/${project.id}/videos/${video.id}`}>
                      {video.name}
                    </WorkspaceLink>
                  </h2>
                  <p className={workspace.description}>
                    创建于 {new Date(video.createdAt).toLocaleString('zh-CN')}
                  </p>
                </article>
              ))}
            </div>
          )}
          {videos.hasNextPage ? (
            <Button
              className={styles.more}
              loading={videos.isFetchingNextPage}
              onClick={() => void videos.fetchNextPage()}
            >
              加载更多视频
            </Button>
          ) : null}
        </>
      )}
      <Modal
        title="新建视频"
        open={open}
        okText="创建并进入"
        cancelText="取消"
        confirmLoading={create.isPending}
        closable={!create.isPending}
        mask={{ closable: !create.isPending }}
        keyboard={!create.isPending}
        cancelButtonProps={{ disabled: create.isPending }}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
      >
        {create.error ? (
          <Alert type="error" showIcon title="视频创建未完成" description={create.error.message} />
        ) : null}
        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => {
            const parsed = createVideoSchema.safeParse(values);
            if (!parsed.success || create.isPending) return;
            create.mutate(parsed.data.name, {
              // 导航回调只属于仍挂载的这次创建会话；离开页面后不再抢回路由。
              onSuccess: (video) => {
                cache.setQueryData(videoKeys.detail(project.id, video.id), video);
                void cache.invalidateQueries({ queryKey: videoKeys.list(project.id) });
                router.push(`/projects/${project.id}/videos/${video.id}`);
              },
            });
          }}
        >
          <Form.Item
            name="name"
            label="视频名称"
            rules={[
              { required: true, whitespace: true, message: '请填写视频名称' },
              { max: 80, message: '视频名称最多 80 个字符' },
            ]}
          >
            <Input maxLength={80} autoFocus placeholder="例如：雨夜来信" />
          </Form.Item>
        </Form>
      </Modal>
    </main>
  );
}
