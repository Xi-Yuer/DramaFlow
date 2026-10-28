'use client';

import {
  iterationItemExecutionMetadataSchema,
  type GraphDefinitionPath,
} from '@dramaflow/contracts';
import type {
  GraphExecutionProjection,
  GraphExecutionSelection,
} from '../../runtime/graph-execution-projection';
import {
  graphExecutionChoiceKey,
  graphPathContains,
  validGraphExecutionChoice,
} from '../../runtime/graph-execution-projection';
import type { GraphExecutionSelectionState } from '../../runtime/use-graph-execution-selection';

export interface IterationItemOption {
  executionId: string;
  index: number;
}
export interface IterationItemSelectorState {
  items: readonly IterationItemOption[];
  executionId?: string;
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
  state,
}: {
  projection: GraphExecutionProjection;
  location: GraphDefinitionPath;
  enabled: boolean;
  state: GraphExecutionSelectionState;
}):
  | { phase: 'inactive' }
  | { phase: 'unavailable'; reason: string }
  | { phase: 'ready'; selection: GraphExecutionSelection; selector: IterationItemSelectorState } {
  const selection = projection.selection;
  // 不把祖先图的歧义错误投影到当前更深的 Definition Location。
  if (
    !enabled ||
    !selection ||
    !['resolved', 'ambiguous', 'unavailable'].includes(projection.phase) ||
    selection.definition.path.length !== location.length ||
    !graphPathContains(selection.definition.path, location)
  )
    return { phase: 'inactive' };
  const items = iterationItemOptions(selection);
  if (!items || items.length === 0)
    return { phase: 'unavailable', reason: 'Item 执行记录缺少有效且唯一的序号，暂时无法选择。' };
  const remembered = state.choices.find(
    (choice) => graphExecutionChoiceKey(choice) === graphExecutionChoiceKey(selection),
  );
  const executionId = remembered
    ? validGraphExecutionChoice(selection, remembered)
      ? remembered.executionId
      : undefined
    : items[0]!.executionId;
  // 首次进入 Body 才应用产品默认值；失效 ID 需要重新选择，不能静默换 Item。
  if (!remembered && executionId) state.select(selection, executionId);
  return {
    phase: 'ready',
    selection,
    selector: {
      items,
      executionId,
      onSelect: (id) => {
        if (items.some((item) => item.executionId === id)) state.select(selection, id);
      },
    },
  };
}
