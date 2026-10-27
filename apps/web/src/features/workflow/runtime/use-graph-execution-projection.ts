'use client';

import { useQuery } from '@tanstack/react-query';
import type { GraphDefinitionPath, WorkflowDefinition } from '@dramaflow/contracts';
import type { WorkflowRunStatusState } from '../run/status/workflow-run-status';
import { workflowApi, workflowKeys } from '../workflow-api';
import {
  projectRootGraphExecution,
  resolveNestedGraphExecution,
  type GraphExecutionProjection,
} from './graph-execution-projection';

export function useGraphExecutionProjection({
  workflow,
  workflowId,
  projectId,
  location,
  runStatus,
}: {
  workflow: WorkflowDefinition;
  workflowId: string;
  projectId: string;
  location: GraphDefinitionPath;
  runStatus: WorkflowRunStatusState | null;
}): GraphExecutionProjection {
  const run = runStatus?.run;
  // 查询实际运行绑定的版本，不使用运行表单中可能已切换的版本选择。
  const version = useQuery({
    queryKey: workflowKeys.version(run?.workflowVersionId ?? 'none'),
    enabled: !!run,
    queryFn: () => workflowApi.getVersion(run!.workflowVersionId),
    staleTime: Infinity,
  });
  let root: GraphExecutionProjection;
  if (runStatus?.phase === 'error')
    root = { phase: 'unavailable', reason: '运行状态读取失败，请刷新后重试。' };
  else if (
    runStatus?.phase === 'loading' ||
    (run && (version.isPending || runStatus?.nodeRuns === undefined))
  )
    root = { phase: 'loading', reason: '正在读取运行版本与节点执行记录…' };
  else if (!run) root = { phase: 'no_execution', reason: '尚未选择工作流运行。' };
  else if (version.isError || !version.data)
    root = { phase: 'unavailable', reason: '运行绑定的发布版本暂不可用。' };
  else
    root = projectRootGraphExecution({
      workflow,
      workflowId,
      projectId,
      run,
      version: version.data,
      nodeRuns: runStatus?.nodeRuns ?? [],
    });

  const nested = useQuery({
    queryKey: [
      'graph-execution-projection',
      run?.id,
      run?.workflowVersionId,
      location,
      runStatus?.nodeRuns,
      run?.status,
    ],
    enabled: location.length > 0 && root.phase === 'resolved',
    queryFn: ({ signal }) => {
      if (root.phase !== 'resolved' || !run || !version.data)
        throw new Error('执行投影上下文不可用');
      return resolveNestedGraphExecution({
        root,
        location,
        version: version.data,
        run,
        nodeRuns: runStatus?.nodeRuns ?? [],
        load: workflowApi.getExecutionTree,
        signal,
      });
    },
    refetchInterval: run && ['pending', 'running', 'waiting'].includes(run.status) ? 2000 : false,
  });
  if (root.phase !== 'resolved' || location.length === 0) return root;
  if (nested.isPending) return { phase: 'loading', reason: '正在定位子图执行实例…' };
  if (nested.isError) return { phase: 'unavailable', reason: '子执行读取失败，请刷新后重试。' };
  return nested.data;
}
