import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ExecutionService, redisConnection } from '@dramaflow/api/worker';
import { Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import { z } from 'zod';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const executor = app.get(ExecutionService);
  const logger = new Logger('WorkflowWorker');
  const worker = new Worker(
    'dramaflow-runs',
    async (job) => {
      const { runId } = z.object({ runId: z.string().min(1) }).parse(job.data);
      await executor.execute(runId);
    },
    {
      connection: redisConnection(),
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
    },
  );
  worker.on('failed', (job) =>
    logger.error(`执行任务失败，等待重试或恢复：${job?.id ?? 'unknown'}`),
  );
  await executor.reconcile();
  const reconciliation = setInterval(() => {
    void executor
      .reconcile()
      .catch(() => logger.error('持久化运行恢复扫描失败'));
  }, 30000);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(reconciliation);
    await worker.close();
    await app.close();
  };
  process.once('SIGTERM', () => {
    void shutdown();
  });
  process.once('SIGINT', () => {
    void shutdown();
  });
}
await bootstrap();
