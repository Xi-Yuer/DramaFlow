'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Form, Input, Modal, Spin } from 'antd';
import { Clapperboard, Plus } from 'lucide-react';
import { createProjectSchema } from '@dramaflow/contracts';
import { AuthBoundary } from '@/features/auth/auth-boundary';
import { AccountMenuButton } from '@/features/auth/account-menu';
import { projectApi, projectKeys } from './project-api';

export function ProjectList() {
  return <AuthBoundary>{() => <ProjectListBody />}</AuthBoundary>;
}

function ProjectListBody() {
  const router = useRouter();
  const cache = useQueryClient();
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ name: string }>();
  const projects = useInfiniteQuery({
    queryKey: projectKeys.list,
    queryFn: ({ pageParam }) => projectApi.list(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const create = useMutation({
    mutationFn: (name: string) => projectApi.create(name),
    onSuccess: async (project) => {
      await cache.invalidateQueries({ queryKey: projectKeys.list });
      router.push(`/projects/${project.id}`);
    },
    onError: (error) => void message.error(error.message),
  });
  const items = projects.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <main className="account-layout">
      <header className="account-header">
        <div className="brand">
          <span className="brand-symbol">
            <Clapperboard size={20} />
          </span>
          <span>DramaFlow</span>
        </div>
        <span className="account-location">项目画布</span>
        <div className="account-actions">
          <Link href="/plugins" className="header-link">
            模型插件
          </Link>
          <AccountMenuButton />
        </div>
      </header>
      <section className="account-space">
        <div className="project-heading">
          <div>
            <span className="small-kicker">ONE CANVAS, ONE PROJECT</span>
            <h1>你的项目</h1>
            <p className="secondary-copy">
              每个项目就是一张画布。右击可以添加文本、角色、图片和模型节点；模型节点使用已安装的插件。
            </p>
          </div>
          <Button type="primary" icon={<Plus size={16} />} onClick={() => setOpen(true)}>
            新建项目
          </Button>
        </div>
        {projects.isPending ? (
          <div className="page-loading">
            <Spin />
          </div>
        ) : projects.error ? (
          <Alert
            type="error"
            title={projects.error.message}
            showIcon
            action={
              <Button size="small" onClick={() => void projects.refetch()}>
                重试
              </Button>
            }
          />
        ) : (
          <>
            <div className="project-grid">
              <button type="button" className="project-create" onClick={() => setOpen(true)}>
                <Plus size={18} />
                <span>新建项目</span>
              </button>
              {items.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className="project-card"
                  onClick={() => router.push(`/projects/${project.id}`)}
                >
                  <span className="project-card-preview" aria-hidden />
                  <span className="project-card-body">
                    <strong>{project.name}</strong>
                    <span>
                      {project.nodeCount} 个节点 ·{' '}
                      {new Date(project.updatedAt).toLocaleString('zh-CN', {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            {projects.hasNextPage ? (
              <Button
                className="project-more"
                loading={projects.isFetchingNextPage}
                onClick={() => void projects.fetchNextPage()}
              >
                加载更多
              </Button>
            ) : null}
          </>
        )}
      </section>
      <Modal
        title="新建项目"
        open={open}
        okText="创建"
        cancelText="取消"
        confirmLoading={create.isPending}
        destroyOnHidden
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
      >
        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => {
            const parsed = createProjectSchema.safeParse(values);
            if (!parsed.success) {
              void message.error('请填写 1 到 80 个字符的项目名称');
              return;
            }
            create.mutate(parsed.data.name);
          }}
        >
          <Form.Item
            name="name"
            label="项目名称"
            rules={[
              { required: true, whitespace: true, message: '请填写项目名称' },
              { max: 80, message: '项目名称最多 80 个字符' },
            ]}
          >
            <Input maxLength={80} placeholder="例如：第一集分镜" autoFocus />
          </Form.Item>
        </Form>
      </Modal>
    </main>
  );
}
