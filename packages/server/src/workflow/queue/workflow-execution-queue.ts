import { createHash } from 'node:crypto';
import { workflowExecutionJobSchema, type WorkflowExecutionJob } from '@dramaflow/contracts';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type Processor, type WorkerOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';

export const workflowQueueName = 'workflow-execution';
export function workflowQueuePrefix(): string {
  return z
    .string()
    .min(1)
    .parse(process.env.WORKFLOW_QUEUE_PREFIX ?? 'dramaflow-workflow');
}
export function workflowExecutionJobId(input: WorkflowExecutionJob): string {
  const job = workflowExecutionJobSchema.parse(input);
  const identity = JSON.stringify([
    job.kind,
    job.workflowRunId,
    job.kind === 'resume' ? job.executionId : null,
  ]);
  return `workflow-${job.kind}-${createHash('sha256').update(identity).digest('hex')}`;
}
function connection(blocking: boolean): Redis {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: blocking ? null : 1,
    connectTimeout: 3000,
    ...(blocking ? {} : { commandTimeout: 5000, enableOfflineQueue: false }),
  });
  redis.on('error', () => new Logger('WorkflowQueue').warn('执行队列 Redis 连接不可用'));
  return redis;
}

// 业务 RedisService 不承担队列连接、重试或阻塞读取；BullMQ 管理独立连接与命名空间。
@Injectable()
export class WorkflowExecutionQueue implements OnModuleDestroy {
  private readonly redis = connection(false);
  readonly queue = new Queue<WorkflowExecutionJob>(workflowQueueName, {
    connection: this.redis,
    prefix: workflowQueuePrefix(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 86400, count: 10000 },
      removeOnFail: { age: 604800, count: 10000 },
    },
  });
  constructor() {
    this.queue.on('error', () => new Logger('WorkflowQueue').warn('执行队列暂不可用'));
  }
  async publish(input: WorkflowExecutionJob): Promise<void> {
    const job = workflowExecutionJobSchema.parse(input);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Redis 尚未建立连接时 waitUntilReady 也必须有界；后台连接仍可自行重连。
      await Promise.race([
        this.queue.waitUntilReady(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('WORKFLOW_QUEUE_UNAVAILABLE')), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    await this.queue.add(job.kind, job, { jobId: workflowExecutionJobId(job) });
  }

  // 正在执行的任务由 Worker 持有锁，不能从队列里抢走；调用方仍删除其持久记录。
  async remove(input: WorkflowExecutionJob): Promise<void> {
    const job = workflowExecutionJobSchema.parse(input);
    try {
      await this.queue.remove(workflowExecutionJobId(job));
    } catch (error) {
      if (error instanceof Error && /locked/i.test(error.message)) return;
      throw error;
    }
  }
  async onModuleDestroy(): Promise<void> {
    const closing = this.queue.close();
    // 此连接由本服务持有；先停止重连，让尚未 ready 的关闭路径也能结束。
    this.redis.disconnect();
    await closing;
  }
}

export function createWorkflowExecutionWorker(
  processor: Processor<unknown, void>,
  options: Partial<WorkerOptions> = {},
): Worker<unknown, void> {
  const redis = connection(true);
  const worker = new Worker<unknown, void>(workflowQueueName, processor, {
    connection: redis,
    prefix: workflowQueuePrefix(),
    autorun: false,
    concurrency: z.coerce
      .number()
      .int()
      .min(1)
      .max(64)
      .parse(process.env.WORKFLOW_WORKER_CONCURRENCY ?? 4),
    maxStalledCount: 2,
    lockDuration: z.coerce
      .number()
      .int()
      .min(1000)
      .parse(process.env.WORKFLOW_QUEUE_LOCK_DURATION_MS ?? 30000),
    stalledInterval: z.coerce
      .number()
      .int()
      .min(1000)
      .parse(process.env.WORKFLOW_QUEUE_STALLED_INTERVAL_MS ?? 30000),
    ...options,
  });
  worker.on('error', () => new Logger('WorkflowConsumer').warn('执行队列 Worker 连接暂不可用'));
  worker.on('closed', () => redis.disconnect());
  return worker;
}
