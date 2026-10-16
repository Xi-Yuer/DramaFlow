'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Spin } from 'antd';
import { z } from 'zod';
import { AuthBoundary } from '@/features/auth/auth-boundary';
import { CanvasEditor } from './canvas-editor';
import { projectApi, projectKeys } from './project-api';

export function CanvasPage({ projectId }: { projectId: string }) {
  return <AuthBoundary>{() => <CanvasLoader projectId={projectId} />}</AuthBoundary>;
}

function CanvasLoader({ projectId }: { projectId: string }) {
  const valid = z.string().uuid().safeParse(projectId).success;
  const [generation, setGeneration] = useState(0);
  const project = useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => projectApi.get(projectId),
    enabled: valid,
  });
  const catalog = useQuery({
    queryKey: projectKeys.catalog,
    queryFn: projectApi.catalog,
    enabled: valid,
    staleTime: 60_000,
  });
  if (!valid)
    return (
      <div className="page-loading">
        <Alert type="error" title="项目地址无效" showIcon />
      </div>
    );
  if (project.isPending || catalog.isPending)
    return (
      <div className="page-loading">
        <Spin size="large" />
        <span>正在打开画布…</span>
      </div>
    );
  if (project.error || catalog.error || !project.data || !catalog.data) {
    const message = project.error?.message ?? catalog.error?.message ?? '无法打开画布';
    return (
      <div className="page-loading">
        <Alert type="error" title={message} showIcon />
        <Button
          onClick={() => {
            void project.refetch();
            void catalog.refetch();
          }}
        >
          重新连接
        </Button>
      </div>
    );
  }
  return (
    <CanvasEditor
      key={generation}
      project={project.data}
      catalog={catalog.data.items}
      onReload={() => {
        void project.refetch().then((result) => {
          if (result.data) setGeneration((value) => value + 1);
        });
      }}
    />
  );
}
