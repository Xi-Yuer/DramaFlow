import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createWorkflowRuntime, type RuntimeResult } from '@dramaflow/workflow';
import {
  humanResponseSchema,
  jsonObjectSchema,
  workflowDefinitionSchema,
  type NodeResult,
} from '@dramaflow/contracts';
import { Pool } from 'pg';
import { DatabaseService } from '../infrastructure/database.service.js';
import { RunQueue } from '../infrastructure/queue.service.js';
import { json } from '../infrastructure/validation.js';
import { RuntimeHostService } from './runtime-host.service.js';
import { mapRun } from '../runs/run-mapper.js';

@Injectable()
export class ExecutionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionService.name);
  private readonly saver = PostgresSaver.fromConnString(
    process.env.DATABASE_URL ?? '',
  );
  private readonly locks = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 4,
  });
  constructor(
    private readonly db: DatabaseService,
    private readonly host: RuntimeHostService,
    private readonly queue: RunQueue,
  ) {}
  async onModuleInit(): Promise<void> {
    await this.saver.setup();
  }
  async onModuleDestroy(): Promise<void> {
    await this.saver.end();
    await this.locks.end();
  }
  async reconcile(): Promise<void> {
    const candidates = await this.db.client.run.findMany({
      where: {
        OR: [
          { status: { in: ['queued', 'running'] } },
          {
            status: 'waiting',
            tasks: { some: { respondedAt: { not: null }, resumedAt: null } },
          },
          { status: 'waiting', cancelRequestedAt: { not: null } },
        ],
      },
      select: { id: true },
      take: 100,
    });
    await Promise.all(
      candidates.map((run) =>
        this.queue.wake(run.id, `recover-${Math.floor(Date.now() / 30000)}`),
      ),
    );
  }
  async execute(runId: string): Promise<void> {
    const connection = await this.locks.connect();
    let locked = false;
    try {
      const result = await connection.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [runId],
      );
      locked = result.rows[0]?.locked === true;
      if (!locked) return;
      await this.executeLocked(runId);
    } finally {
      if (locked)
        await connection.query(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
          [runId],
        );
      connection.release();
    }
  }
  private async executeLocked(runId: string): Promise<void> {
    const run = await this.db.client.run.findUniqueOrThrow({
      where: { id: runId },
      include: { version: true, attempts: true },
    });
    if (['succeeded', 'failed', 'canceled'].includes(run.status)) return;
    if (run.cancelRequestedAt) {
      await this.finish(runId, {
        status: 'canceled',
        nodeResults: mapRun(run).nodeResults,
        outputCollections: mapRun(run).outputCollections,
        interrupts: [],
      });
      return;
    }
    const definition = workflowDefinitionSchema.parse(run.version.definition);
    if (run.regenerateNodeId) {
      const node = definition.nodes.find(
        (candidate) => candidate.id === run.regenerateNodeId,
      );
      if (node)
        node.config = {
          ...node.config,
          ...jsonObjectSchema.parse(run.configOverrides),
        };
    }
    const runtime = createWorkflowRuntime({
      definition,
      host: this.host,
      checkpointer: this.saver,
    });
    const controller = new AbortController();
    let checking = false;
    const cancellation = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.host
        .isCancelled(runId)
        .then((cancelled) => {
          if (cancelled) controller.abort();
        })
        .catch(() => this.logger.warn(`无法读取取消状态：${runId}`))
        .finally(() => {
          checking = false;
        });
    }, 1000);
    try {
      if (run.status === 'queued') {
        await this.db.client.$transaction([
          this.db.client.run.update({
            where: { id: runId },
            data: { status: 'running', startedAt: new Date() },
          }),
          this.db.client.runEvent.create({
            data: { runId, type: 'run.started', data: {} },
          }),
        ]);
      }
      const checkpoint = await this.saver.getTuple({
        configurable: { thread_id: `${runId}:1` },
      });
      let result: RuntimeResult;
      if (checkpoint)
        result = await runtime.recover({
          runId,
          attemptId: '1',
          signal: controller.signal,
        });
      else {
        const reusedResults: Record<string, NodeResult> = {};
        if (run.parentRunId) {
          const parent = await this.db.client.run.findUniqueOrThrow({
            where: { id: run.parentRunId },
            include: { attempts: true },
          });
          const invalidated = new Set(run.invalidatedNodeIds as string[]);
          for (const [nodeId, value] of Object.entries(
            mapRun(parent).nodeResults,
          ))
            if (
              !invalidated.has(nodeId) &&
              ['succeeded', 'skipped'].includes(value.status)
            )
              reusedResults[nodeId] = value;
        }
        result = await runtime.invoke({
          runId,
          attemptId: '1',
          inputs: jsonObjectSchema.parse(run.inputs),
          reusedResults,
          ...(run.regenerateNodeId
            ? {
                executeNodeIds: run.continueDownstream
                  ? (run.invalidatedNodeIds as string[])
                  : [run.regenerateNodeId],
              }
            : {}),
          signal: controller.signal,
        });
      }
      const responses = await this.db.client.humanTask.findMany({
        where: { runId, respondedAt: { not: null }, resumedAt: null },
        orderBy: { respondedAt: 'asc' },
      });
      for (const task of responses) {
        if (
          result.interrupts.some((pending) => pending.id === task.interruptId)
        )
          result = await runtime.resume({
            runId,
            attemptId: '1',
            interruptId: task.interruptId,
            response: humanResponseSchema.parse(task.response),
            signal: controller.signal,
          });
        await this.db.client.humanTask.update({
          where: { id: task.id },
          data: { resumedAt: new Date() },
        });
      }
      await this.finish(runId, result);
    } catch (error) {
      if (await this.host.isCancelled(runId)) {
        const current = await this.db.client.run.findUniqueOrThrow({
          where: { id: runId },
          include: { attempts: true },
        });
        await this.finish(runId, {
          status: 'canceled',
          nodeResults: mapRun(current).nodeResults,
          outputCollections: mapRun(current).outputCollections,
          interrupts: [],
        });
        return;
      }
      this.logger.error(
        `执行进程中断，队列将恢复：${runId} (${error instanceof Error ? error.name : 'unknown'})`,
      );
      throw new Error(`运行 ${runId} 等待持久化恢复`);
    } finally {
      clearInterval(cancellation);
    }
  }
  private async finish(runId: string, result: RuntimeResult): Promise<void> {
    if (result.status === 'canceled') await this.host.cancelOperations(runId);
    const failure = Object.values(result.nodeResults).find(
      (node) => node.error,
    )?.error;
    await this.db.client.$transaction([
      this.db.client.run.update({
        where: { id: runId },
        data: {
          status: result.status,
          output: json(result.outputCollections),
          ...(result.status === 'failed'
            ? {
                error: json(
                  failure ?? { code: 'RUN_FAILED', message: '工作流执行失败' },
                ),
              }
            : {}),
          ...(result.status !== 'waiting' ? { finishedAt: new Date() } : {}),
        },
      }),
      this.db.client.runEvent.create({
        data: {
          runId,
          type: `run.${result.status}`,
          data: { status: result.status },
        },
      }),
    ]);
  }
}
