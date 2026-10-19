import type { DataType, RuntimeValue, StaticInputBinding } from '@dramaflow/contracts';
import type { WorkflowState } from './state.js';
import type { RuntimeValueContext } from './value-codec.js';
export interface BindingResolveContext extends RuntimeValueContext {
  readonly state: WorkflowState;
}
export interface BindingResolver {
  // 执行管线可保留本次实际引用用于审计，再 decode；避免把临时媒体 URL 反向编码为快照。
  resolveValue(
    binding: StaticInputBinding,
    expectedType: DataType,
    context: BindingResolveContext,
  ): Promise<RuntimeValue>;
  resolve(
    binding: StaticInputBinding,
    expectedType: DataType,
    context: BindingResolveContext,
  ): Promise<unknown>;
}
