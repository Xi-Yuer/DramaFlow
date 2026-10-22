import { workflowPortNameSchema } from '@dramaflow/contracts';
import { z } from 'zod';

type HandleDirection = 'source' | 'target';
type WorkflowHandle = { kind: 'data'; portKey: string } | { kind: 'control'; portKey?: string };

// 冒号不属于数据端口 key 的合法字符，控制 Handle 不会与 data key 重名。
export function controlHandleId(direction: HandleDirection, portKey?: string): string {
  const prefix = `control:${direction}`;
  return portKey === undefined ? prefix : `${prefix}:${workflowPortNameSchema.parse(portKey)}`;
}

export function parseWorkflowHandle(input: unknown, direction: HandleDirection): WorkflowHandle {
  const handle = z.string().parse(input);
  const prefix = controlHandleId(direction);
  if (handle === prefix) return { kind: 'control' };
  if (handle.startsWith(`${prefix}:`)) {
    return {
      kind: 'control',
      portKey: workflowPortNameSchema.parse(handle.slice(prefix.length + 1)),
    };
  }
  return { kind: 'data', portKey: workflowPortNameSchema.parse(handle) };
}

// 拖线预览与落线操作采用同一分类；完整端点和类型校验仍由 adapter 执行。
export function areWorkflowHandlesCompatible(source: unknown, target: unknown): boolean {
  try {
    return (
      parseWorkflowHandle(source, 'source').kind === parseWorkflowHandle(target, 'target').kind
    );
  } catch (error) {
    if (error instanceof z.ZodError) return false;
    throw error;
  }
}
