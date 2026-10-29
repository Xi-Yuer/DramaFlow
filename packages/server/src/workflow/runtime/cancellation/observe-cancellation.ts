import { Logger } from '@nestjs/common';
import { WorkflowExecutionCancellation } from '@dramaflow/workflow';
import type { DatabaseService } from '../../../database/database.service.js';

// DB 是取消事实来源；一个在途执行只有一个有界轮询，不使用队列 Job 状态或同进程通知。
export function observeWorkflowCancellation(
  db: DatabaseService,
  cancellation: WorkflowExecutionCancellation,
  intervalMs = 250,
): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> = Promise.resolve();
  let warned = false;
  const schedule = () => {
    if (stopped || cancellation.signal.aborted) return;
    timer = setTimeout(() => {
      active = poll();
    }, intervalMs);
    timer.unref();
  };
  const poll = async () => {
    try {
      const run = await db.client.workflowRun.findUnique({
        where: { id: cancellation.workflowRunId },
        select: { cancellationRequestedAt: true },
      });
      if (!stopped && run?.cancellationRequestedAt) cancellation.request();
      warned = false;
    } catch {
      // 暂时读取失败不等于取消或业务失败；后续继续从持久化源读取，不伪造成功。
      if (!warned) new Logger('WorkflowCancellation').warn('取消意图暂不可读，继续等待持久化状态');
      warned = true;
    } finally {
      schedule();
    }
  };
  schedule();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await active;
  };
}
