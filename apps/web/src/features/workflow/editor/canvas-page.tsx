'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Spin } from 'antd';
import type { Project } from '@dramaflow/contracts';
import { ApiError } from '@/lib/http';
import { z } from 'zod';
import { CanvasEditor } from './canvas-editor';
import { workflowApi, workflowKeys } from '@/features/workflow/workflow-api';

export function CanvasPage({ project, workflowId }: { project: Project; workflowId: string }) {
  if (!z.uuid().safeParse(workflowId).success)
    return <Alert type="error" showIcon title="工作流地址无效" />;
  return (
    <>
      <CanvasLoader key={`${project.id}:${workflowId}`} project={project} workflowId={workflowId} />
    </>
  );
}
function CanvasLoader({ project, workflowId }: { project: Project; workflowId: string }) {
  const workflow = useQuery({
    queryKey: workflowKeys.detail(project.id, workflowId),
    queryFn: async () => {
      const result = await workflowApi.get(project.id, workflowId);
      if (result.id !== workflowId || result.projectId !== project.id)
        throw new ApiError('工作流响应与当前地址不匹配', 200);
      return result;
    },
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnReconnect: false,
  });
  if (workflow.isPending)
    return (
      <div className="page-loading" role="status">
        <Spin size="large" />
        <span>正在读取工作流草稿…</span>
      </div>
    );
  const denied =
    workflow.error instanceof ApiError && [401, 403, 404].includes(workflow.error.status);
  if (!workflow.data || denied)
    return (
      <div className="page-loading">
        <Alert
          type="error"
          title="工作流读取失败"
          description={workflow.error?.message ?? '无法读取服务器草稿'}
          showIcon
        />
        <Button onClick={() => void workflow.refetch()}>重新读取工作流</Button>
      </div>
    );
  return (
    <>
      {workflow.error ? (
        <Alert
          type="warning"
          showIcon
          title="工作流暂时无法刷新，当前编辑仍保留"
          action={<Button onClick={() => void workflow.refetch()}>重试</Button>}
        />
      ) : null}
      <CanvasEditor project={project} workflow={workflow.data} />
    </>
  );
}
