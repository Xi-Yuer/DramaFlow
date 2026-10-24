import { readFileSync, writeFileSync } from 'node:fs';
import { Command, openSaver, z } from './dependencies.ts';
import type { StateSnapshot } from './dependencies.ts';
import { createMapGraph, createNestedGraph, Recorder } from './graphs.ts';

const requestSchema = z
  .object({
    operation: z.enum(['start', 'resume', 'inspect']),
    mode: z.enum(['basic', 'review', 'nested']),
    threadId: z.string().startsWith('iteration-experiment-'),
    count: z.number().int().min(0).max(100),
    maxConcurrency: z.number().int().min(1).max(5).optional(),
    eventPath: z.string(),
    outputPath: z.string(),
    resume: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type Request = import('zod').infer<typeof requestSchema>;

export interface SnapshotView {
  checkpointId: unknown;
  checkpointNs: unknown;
  values: unknown;
  next: string[];
  tasks: {
    id: string;
    name: string;
    path: unknown;
    error?: unknown;
    interrupts: unknown;
    state?: unknown;
  }[];
}
function snapshotView(snapshot: StateSnapshot): SnapshotView {
  return {
    checkpointId: snapshot.config.configurable?.checkpoint_id,
    checkpointNs: snapshot.config.configurable?.checkpoint_ns,
    values: snapshot.values as unknown,
    next: [...snapshot.next],
    tasks: snapshot.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      path: task.path,
      error: task.error,
      interrupts: task.interrupts,
      ...(task.state
        ? {
            state:
              'values' in task.state
                ? snapshotView(task.state)
                : { configurable: task.state.configurable },
          }
        : {}),
    })),
  };
}

const requestFile = process.argv[2];
if (!requestFile) throw new Error('缺少实验进程请求文件');
const request = requestSchema.parse(JSON.parse(readFileSync(requestFile, 'utf8')));
const recorder = new Recorder(request.eventPath);
const saver = openSaver();
const graph =
  request.mode === 'nested'
    ? createNestedGraph(recorder, saver)
    : createMapGraph(recorder, request.mode === 'review', saver);
const config = {
  configurable: { thread_id: request.threadId },
  ...(request.maxConcurrency ? { maxConcurrency: request.maxConcurrency } : {}),
  recursionLimit: 40,
};
const output: Record<string, unknown> = { pid: process.pid, request, config };
try {
  if (request.operation !== 'start')
    output.before = snapshotView(await graph.getState(config, { subgraphs: true }));
  if (request.operation !== 'inspect') {
    const input =
      request.operation === 'resume'
        ? new Command<unknown, never, never>({ resume: request.resume ?? {} })
        : {
            items: Array.from({ length: request.count }, (_, index) => ({ index, value: index })),
            outerIndex: -1,
            results: [],
          };
    try {
      const value: unknown = await graph.invoke(input, {
        ...config,
        signal: AbortSignal.timeout(8000),
      });
      output.invoke = { status: 'returned', value };
    } catch (error) {
      output.invoke = {
        status: 'threw',
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'UnknownError' },
      };
    }
  }
  output.after = snapshotView(await graph.getState(config, { subgraphs: true }));
  // 只通过官方 Saver API 查看所有 namespace 的 head 和 pending writes，不读 checkpoint SQL 表。
  const heads = new Map<string, unknown>();
  let checkpoints = 0;
  for await (const tuple of saver.list({ configurable: { thread_id: request.threadId } })) {
    checkpoints++;
    const namespace = String(tuple.config.configurable?.checkpoint_ns ?? '');
    if (!heads.has(namespace))
      heads.set(namespace, {
        namespace,
        checkpointId: tuple.checkpoint.id,
        metadata: tuple.metadata,
        pendingWrites: tuple.pendingWrites,
      });
  }
  output.checkpointCount = checkpoints;
  output.namespaceHeads = [...heads.values()];
} finally {
  await saver.end();
  writeFileSync(request.outputPath, `${JSON.stringify(output, null, 2)}\n`);
}
