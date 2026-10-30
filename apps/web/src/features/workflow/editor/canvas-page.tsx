'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Spin } from 'antd';
import { CanvasEditor } from './canvas-editor';
import type { Project } from '@dramaflow/contracts';
import { ApiError } from '@/lib/http';
import { workflowApi, workflowKeys } from '@/features/workflow/workflow-api';

export function CanvasPage({ project }: { project: Project }) {
  const cache = useQueryClient();
  const key = workflowKeys.project(project.id);
  const workflow = useQuery({
    queryKey: key,
    queryFn: () => workflowApi.get(project.id),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnReconnect: false,
  });
  const initialize = useMutation({
    mutationFn: () => workflowApi.initialize(project.id),
    retry: false,
    onSuccess: (result) => cache.setQueryData(key, result),
  });
  if (workflow.isPending || workflow.isFetching)
    return (
      <div className="page-loading" role="status">
        <Spin size="large" />
        <span>正在读取工作流草稿…</span>
      </div>
    );
  if (workflow.error instanceof ApiError && workflow.error.status === 404)
    return (
      <div className="page-loading">
        <Alert
          type="info"
          title="此项目尚未建立工作流"
          description="初始化后会创建可保存的空白草稿。已有工作流不会被覆盖。"
          showIcon
        />
        {initialize.error ? (
          <Alert
            type="error"
            title="工作流初始化失败"
            description={initialize.error.message}
            showIcon
          />
        ) : null}
        <Button type="primary" loading={initialize.isPending} onClick={() => initialize.mutate()}>
          {initialize.isPending ? '正在初始化工作流…' : '初始化工作流'}
        </Button>
        <Button href="/projects">返回项目</Button>
      </div>
    );
  if (workflow.error || !workflow.data)
    return (
      <div className="page-loading">
        <Alert
          type="error"
          title="工作流读取失败"
          description={workflow.error?.message ?? '无法读取服务器草稿'}
          showIcon
        />
        <Button onClick={() => void workflow.refetch()}>重新读取工作流</Button>
        <Button href="/projects">返回项目</Button>
      </div>
    );
  return <CanvasEditor project={project} workflow={workflow.data} />;
}
