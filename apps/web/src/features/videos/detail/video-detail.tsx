'use client';

import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Form, Input, Select, Spin } from 'antd';
import { z } from 'zod';
import type { Video } from '@dramaflow/contracts';
import { ApiError } from '@/lib/http';
import { useProjectWorkspace } from '@/features/projects/workspace/workspace-context';
import { WorkspaceLink } from '@/features/projects/workspace/workspace-link';
import { videoApi, videoKeys } from '../api/video-api';
import { videoStatusLabels, VideoStatusTag } from '../presentation/video-status';
import { useVideoEditor } from './use-video-editor';
import workspace from '@/features/projects/workspace/workspace.module.css';
import styles from '../videos.module.css';

export function VideoDetail({ videoId }: { videoId: string }) {
  const { project } = useProjectWorkspace();
  const valid = z.uuid().safeParse(videoId).success;
  const video = useQuery({
    queryKey: videoKeys.detail(project.id, videoId),
    queryFn: () => videoApi.get(project.id, videoId),
    enabled: valid,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnReconnect: false,
  });
  const denied = video.error instanceof ApiError && [401, 403, 404].includes(video.error.status);
  return (
    <main className={workspace.page}>
      <WorkspaceLink href={`/projects/${project.id}/videos`}>返回视频列表</WorkspaceLink>
      {!valid ? (
        <Alert type="error" showIcon title="视频地址无效" />
      ) : video.isPending ? (
        <div className={styles.loading} role="status">
          <Spin />
          <span>正在读取视频作品…</span>
        </div>
      ) : !video.data || denied ? (
        <Alert
          type="error"
          showIcon
          title="视频作品无法打开"
          description={video.error?.message}
          action={<Button onClick={() => void video.refetch()}>重新读取视频</Button>}
        />
      ) : (
        <>
          {video.error ? (
            <Alert
              type="warning"
              showIcon
              title="视频信息暂时无法刷新，当前编辑仍保留"
              action={<Button onClick={() => void video.refetch()}>重试</Button>}
            />
          ) : null}
          <VideoEditor key={video.data.id} video={video.data} />
        </>
      )}
    </main>
  );
}

function VideoEditor({ video }: { video: Video }) {
  const { project } = useProjectWorkspace();
  const editor = useVideoEditor(video);
  const busy = editor.operation !== 'idle';
  return (
    <>
      <div className={workspace.heading}>
        <h1>{editor.saved.name}</h1>
        <VideoStatusTag status={editor.saved.status} />
        <p>视频作品的基础信息。名称和生命周期可独立维护。</p>
      </div>
      <div className={styles.detail}>
        {editor.error ? (
          <Alert
            type={editor.conflict ? 'warning' : 'error'}
            showIcon
            title={editor.conflict ? '视频信息已在其他页面更新' : '视频操作未完成'}
            description={`${editor.error} 当前本地修改仍保留。`}
            action={
              <Button disabled={busy} onClick={editor.reload}>
                重新读取视频信息
              </Button>
            }
          />
        ) : null}
        <section className={workspace.card} aria-label="视频基本信息">
          <Form layout="vertical" onFinish={() => void editor.save()}>
            <Form.Item label="视频名称" htmlFor="video-name" required>
              <Input
                id="video-name"
                value={editor.name}
                maxLength={80}
                disabled={editor.operation === 'reloading' || editor.operation === 'removing'}
                onChange={(event) => editor.setName(event.target.value)}
              />
            </Form.Item>
            <Form.Item
              label="生命周期"
              htmlFor="video-status"
              extra="由你手动维护作品状态，不代表任何生成任务或视频文件的状态。"
            >
              <Select
                id="video-status"
                value={editor.status}
                disabled={busy}
                onChange={editor.setStatus}
                options={Object.entries(videoStatusLabels).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={editor.operation === 'saving'}
              disabled={!editor.dirty || editor.conflict || busy}
            >
              保存视频信息
            </Button>
          </Form>
        </section>
        <section className={workspace.card} aria-label="作品身份">
          <Descriptions
            column={1}
            title="作品身份"
            items={[
              { key: 'id', label: '作品 ID', children: editor.saved.id },
              { key: 'project', label: '所属项目', children: project.name },
              {
                key: 'created',
                label: '创建时间',
                children: new Date(editor.saved.createdAt).toLocaleString('zh-CN'),
              },
              {
                key: 'updated',
                label: '更新时间',
                children: new Date(editor.saved.updatedAt).toLocaleString('zh-CN'),
              },
            ]}
          />
        </section>
        <section className={workspace.card} aria-label="删除视频作品">
          <h2>删除视频作品</h2>
          <p className={workspace.description}>永久删除此作品身份，此操作不能撤销。</p>
          <Button danger disabled={busy} onClick={editor.remove}>
            删除视频
          </Button>
        </section>
      </div>
    </>
  );
}
