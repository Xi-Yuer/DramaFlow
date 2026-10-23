'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Dropdown, Form, Input, Modal, Spin } from 'antd';
import { Clapperboard, Ellipsis, Plus, Trash2 } from 'lucide-react';
import { ApiError } from '@/lib/http';
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
  const { message, modal } = App.useApp();
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
  const remove = useMutation({
    mutationFn: (id: string) => projectApi.remove(id),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: projectKeys.list });
      void message.success('项目已删除');
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 503)
        await cache.invalidateQueries({ queryKey: projectKeys.list });
      void message.error(error.message);
    },
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
          <AccountMenuButton />
        </div>
      </header>
      <section className="account-space">
        <div className="project-heading">
          <div>
            <span className="small-kicker">ONE CANVAS, ONE PROJECT</span>
            <h1>你的项目</h1>
            <p className="secondary-copy">每个项目就是一张画布，当前从空白画布开始。</p>
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
                <article key={project.id} className="project-card">
                  <button
                    type="button"
                    className="project-card-open"
                    onClick={() => router.push(`/projects/${project.id}`)}
                  >
                    <span className="project-card-preview" aria-hidden />
                    <span className="project-card-body">
                      <strong>{project.name}</strong>
                      <span>
                        {new Date(project.updatedAt).toLocaleString('zh-CN', {
                          month: 'numeric',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </span>
                  </button>
                  <span className="project-card-more">
                    <Dropdown
                      trigger={['click']}
                      placement="topRight"
                      menu={{
                        items: [
                          {
                            key: 'delete',
                            danger: true,
                            icon: <Trash2 size={14} />,
                            label: '删除项目',
                            disabled: remove.isPending && remove.variables === project.id,
                          },
                        ],
                        onClick: ({ key }) => {
                          if (key !== 'delete') return;
                          modal.confirm({
                            title: `删除「${project.name}」？`,
                            content:
                              '将删除该项目的工作流、版本、运行记录、队列任务、Checkpoint 和已保存素材。账号中的模型配置会保留。此操作不能撤销。',
                            okText: '删除',
                            cancelText: '取消',
                            okButtonProps: { danger: true },
                            onOk: () => remove.mutateAsync(project.id),
                          });
                        },
                      }}
                    >
                      <Button
                        type="text"
                        size="small"
                        aria-label={`${project.name} 的更多操作`}
                        icon={<Ellipsis size={16} />}
                        loading={remove.isPending && remove.variables === project.id}
                      />
                    </Dropdown>
                  </span>
                </article>
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
