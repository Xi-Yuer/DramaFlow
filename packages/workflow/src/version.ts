import type { WorkflowVersionMetadata } from '@dramaflow/contracts';
import { z } from 'zod';

export type DeepReadonly<T> = T extends object
  ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
  : T;

function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  // 上方递归冻结所有已验证的 JSON 子对象；断言仅将这一结果表达为只读类型。
  return value as DeepReadonly<T>;
}

// 调用方必须提供完整定义的版本 Schema；此函数不替代权限、图校验或持久化发布。
export function createWorkflowVersionSnapshot<Definition>(
  versionSchema: z.ZodType<WorkflowVersionMetadata & { definition: Definition }>,
  input: unknown,
): DeepReadonly<WorkflowVersionMetadata & { definition: Definition }> {
  const version = versionSchema.parse(input);
  z.json().parse(version);
  return freeze(structuredClone(version));
}
