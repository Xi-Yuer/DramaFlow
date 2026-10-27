'use client';

import { useState } from 'react';
import {
  iterationItemExecutionMetadataSchema,
  type GraphDefinitionPath,
} from '@dramaflow/contracts';
import type {
  GraphExecutionProjection,
  GraphExecutionSelection,
} from '../../runtime/graph-execution-projection';

export interface IterationItemOption {
  executionId: string;
  index: number;
}
export interface IterationItemSelectorState {
  items: readonly IterationItemOption[];
  executionId: string;
  onSelect: (executionId: string) => void;
}

export function iterationItemOptions(
  selection: GraphExecutionSelection,
): IterationItemOption[] | null {
  const items: IterationItemOption[] = [];
  const indexes = new Set<number>();
  for (const candidate of selection.candidates) {
    const metadata = iterationItemExecutionMetadataSchema.safeParse(candidate.metadata);
    if (
      candidate.kind !== 'iteration_item' ||
      !metadata.success ||
      indexes.has(metadata.data.index)
    )
      return null;
    indexes.add(metadata.data.index);
    items.push({ executionId: candidate.executionId, index: metadata.data.index });
  }
  return items.sort((a, b) => a.index - b.index);
}

// 只管理 UI 选择策略，不计算 NodeRun 状态。Run / 版本 / 定义位置 / 父 attempt 隔离选择。
export function useIterationItemSelection({
  projection,
  location,
  enabled,
}: {
  projection: GraphExecutionProjection;
  location: GraphDefinitionPath;
  enabled: boolean;
}):
  | { phase: 'inactive' }
  | { phase: 'unavailable'; reason: string }
  | { phase: 'ready'; selection: GraphExecutionSelection; selector: IterationItemSelectorState } {
  const [remembered, setRemembered] = useState<Readonly<Record<string, string>>>({});
  const selection = projection.selection;
  // 不把祖先图的歧义错误投影到当前更深的 Definition Location。
  if (
    !enabled ||
    !selection ||
    !['resolved', 'ambiguous'].includes(projection.phase) ||
    JSON.stringify(selection.definition.path) !== JSON.stringify(location)
  )
    return { phase: 'inactive' };
  const items = iterationItemOptions(selection);
  if (!items || items.length === 0)
    return { phase: 'unavailable', reason: 'Item 执行记录缺少有效且唯一的序号，暂时无法选择。' };
  const key = JSON.stringify([
    selection.workflowRunId,
    selection.definition,
    selection.parentNodeRunId,
  ]);
  const executionId =
    items.find((item) => item.executionId === remembered[key])?.executionId ??
    items[0]!.executionId;
  // fallback 立即成为当前选择；旧 ID 后续重新出现也不抢走用户正在查看的 Item。
  if (remembered[key] !== executionId) setRemembered({ ...remembered, [key]: executionId });
  return {
    phase: 'ready',
    selection,
    selector: {
      items,
      executionId,
      onSelect: (id) => {
        if (items.some((item) => item.executionId === id))
          setRemembered((current) => ({ ...current, [key]: id }));
      },
    },
  };
}
