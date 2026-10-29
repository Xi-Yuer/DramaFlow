import {
  collectionRuntimeValueSchema,
  runtimeValueMapSchema,
  executionScopeKeySchema,
  workflowIdentifierSchema,
  type CollectionRuntimeValue,
  type RuntimeValue,
} from '@dramaflow/contracts';
import { Annotation } from '@langchain/langgraph';
import { z } from 'zod';
import { graphDefinitionLocationSchema } from '../../runtime/execution/execution-scope.js';
import { WorkflowStateAnnotation, type WorkflowState } from '../../runtime/state/state.js';

// ':' 不能成为合法 LangGraph 节点名，避免新增内部通道与用户 Definition nodeId 冲突。
export const FRAME = '__dramaflow:iteration';
export const INVOCATION = '__dramaflow:invocation';
export const CHILD_EXECUTION = '__dramaflow:child_execution';
export const RESULTS = '__dramaflow:results';
export const frameSchema = z
  .object({
    ownerOccurrenceId: workflowIdentifierSchema,
    iterationNodeRunId: workflowIdentifierSchema,
    snapshot: collectionRuntimeValueSchema,
    invariantInputs: runtimeValueMapSchema,
  })
  .strict();
export interface IterationFrame {
  ownerOccurrenceId: string;
  iterationNodeRunId: string;
  snapshot: CollectionRuntimeValue;
  invariantInputs: Record<string, RuntimeValue>;
}
export const itemInvocationSchema = z
  .object({
    ownerOccurrenceId: workflowIdentifierSchema,
    iterationNodeRunId: workflowIdentifierSchema,
    scopeKey: executionScopeKeySchema,
    index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    definitionLocation: graphDefinitionLocationSchema,
  })
  .strict();
export const itemResultSchema = itemInvocationSchema
  .omit({ definitionLocation: true })
  .extend({ childExecutionId: workflowIdentifierSchema, outputs: runtimeValueMapSchema })
  .strict();
export type ItemResult = z.infer<typeof itemResultSchema>;
export function mergeIterationResults(current: ItemResult[], update: ItemResult[]): ItemResult[] {
  const seen = new Set(current.map((item) => item.index));
  for (const item of update) {
    itemResultSchema.parse(item);
    if (seen.has(item.index)) throw new Error('Iteration 结果 index 重复');
    seen.add(item.index);
  }
  return [...current, ...update];
}
// 父图只接收 collect 写回的输出增量，因此这些通道保持 LastValue，不能复用带 reducer 的 WorkflowState。
export const ParentInput = Annotation.Root({
  run: Annotation<WorkflowState['run']>(),
  inputs: Annotation<WorkflowState['inputs']>(),
  outputs: Annotation<WorkflowState['outputs']>(),
  variables: Annotation<WorkflowState['variables']>(),
  execution: Annotation<WorkflowState['execution']>(),
});
export const AggregateOutput = Annotation.Root({ outputs: Annotation<WorkflowState['outputs']>() });
export const IterationState = Annotation.Root({
  ...ParentInput.spec,
  [FRAME]: Annotation<IterationFrame>(),
  [RESULTS]: Annotation<ItemResult[]>({ reducer: mergeIterationResults, default: () => [] }),
});
// Send 输入必须能注册到 Iteration 图。LastValue 可与已有同名通道共存；body 内部仍使用带 reducer 的 ItemState。
export const ItemInput = Annotation.Root({
  run: Annotation<WorkflowState['run']>(),
  inputs: Annotation<WorkflowState['inputs']>(),
  outputs: Annotation<WorkflowState['outputs']>(),
  variables: Annotation<WorkflowState['variables']>(),
  execution: Annotation<WorkflowState['execution']>(),
  [INVOCATION]: Annotation<z.infer<typeof itemInvocationSchema>>(),
});
export const ItemOutput = Annotation.Root({ [RESULTS]: Annotation<ItemResult[]>() });
export const ItemState = Annotation.Root({
  ...WorkflowStateAnnotation.spec,
  [INVOCATION]: Annotation<z.infer<typeof itemInvocationSchema>>(),
  [CHILD_EXECUTION]: Annotation<string>(),
  ...ItemOutput.spec,
});
