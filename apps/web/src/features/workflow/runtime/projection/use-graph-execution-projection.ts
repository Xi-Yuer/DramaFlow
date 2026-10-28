'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ExecutionTreeParentRef,
  GraphDefinitionPath,
  WorkflowDefinition,
} from '@dramaflow/contracts';
import type { WorkflowRunStatusState } from '../../run/status/workflow-run-status';
import { workflowApi, workflowKeys } from '../../workflow-api';
import {
  projectRootGraphExecution,
  resolveNestedGraphExecution,
  projectCachedNestedGraphExecution,
  loadExecutionChildren,
  graphPathContains,
  type GraphExecutionChoice,
  type GraphExecutionProjection,
} from './graph-execution-projection';

export function useGraphExecutionProjection({
  workflow,
  workflowId,
  projectId,
  location,
  runStatus,
  choices = [],
}: {
  workflow: WorkflowDefinition;
  workflowId: string;
  projectId: string;
  location: GraphDefinitionPath;
  runStatus: WorkflowRunStatusState | null;
  choices?: readonly GraphExecutionChoice[];
}): GraphExecutionProjection {
  const queryClient = useQueryClient();
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

  const ancestors = choices.filter(
    (choice) =>
      choice.workflowRunId === run?.id &&
      choice.definition.workflowVersionId === run.workflowVersionId &&
      graphPathContains(choice.definition.path, location),
  );
  const childrenQuery = (parent: ExecutionTreeParentRef) => ({
    queryKey: [
      'graph-execution-projection',
      run?.id,
      run?.workflowVersionId,
      'children',
      parent,
      runStatus?.nodeRuns,
      run?.status,
    ],
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      if (!run) throw new Error('执行投影上下文不可用');
      return loadExecutionChildren(workflowApi.getExecutionTree, run, parent, signal);
    },
    staleTime: run && ['pending', 'running', 'waiting'].includes(run.status) ? 2000 : Infinity,
    // 页面 session 内复用完整 parent 集合；路径与 selection 不属于此缓存身份。
    gcTime: 5 * 60 * 1000,
  });
  const cached =
    root.phase === 'resolved' && run && version.data && location.length > 0
      ? projectCachedNestedGraphExecution({
          root,
          run,
          version: version.data,
          location,
          choices: ancestors,
          nodeRuns: runStatus?.nodeRuns ?? [],
          readChildren: (parent) => {
            const options = childrenQuery(parent);
            const state = queryClient.getQueryState(options.queryKey);
            return state?.isInvalidated || state?.status === 'error'
              ? undefined
              : queryClient.getQueryData(options.queryKey);
          },
        })
      : undefined;
  const nested = useQuery({
    queryKey: [
      'graph-execution-projection',
      run?.id,
      run?.workflowVersionId,
      location,
      runStatus?.nodeRuns,
      run?.status,
      ancestors,
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
        choices: ancestors,
        loadChildren: (parent) => queryClient.fetchQuery(childrenQuery(parent)),
      });
    },
    initialData: cached,
    staleTime: Infinity,
    refetchInterval: run && ['pending', 'running', 'waiting'].includes(run.status) ? 2000 : false,
  });
  // 即便同步缓存已命中，也订阅最终查询数据变化，保证刷新完成后重新投影。
  const result = nested.data;
  if (root.phase !== 'resolved' || location.length === 0) return root;
  if (nested.isError) return { phase: 'unavailable', reason: '子执行读取失败，请刷新后重试。' };
  if (cached) return cached;
  if (nested.isPending || !result) return { phase: 'loading', reason: '正在定位子图执行实例…' };
  return result;
}
