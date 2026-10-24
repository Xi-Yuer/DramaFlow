import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  databaseName,
  databaseUrl,
  experimentRoot,
  openSaver,
  pg,
  repositoryRoot,
  versions,
  z,
} from './dependencies.ts';
import type { Request } from './process.ts';
import { reproduce } from './repro-max-concurrency.ts';

if (existsSync(join(repositoryRoot, '.env'))) process.loadEnvFile(join(repositoryRoot, '.env'));
const evidence = join(experimentRoot, 'evidence');
mkdirSync(evidence, { recursive: true });
const runId = randomUUID();
const startedAt = new Date().toISOString();

const valueSchema = z
  .object({
    index: z.number().int(),
    outerIndex: z.number().int(),
    value: z.number(),
    decision: z.string().optional(),
  })
  .strict();
const interruptSchema = z
  .object({
    id: z.string(),
    value: z
      .object({
        kind: z.literal('runtime_experiment'),
        index: z.number().int(),
        outerIndex: z.number().int(),
        value: z.number(),
        taskId: z.string(),
        checkpointNs: z.string(),
        nodeAttempt: z.number().int(),
      })
      .strict(),
  })
  .passthrough();
type InterruptObservation = import('zod').infer<typeof interruptSchema>;
const stateValuesSchema = z
  .object({ results: z.array(valueSchema).optional(), ordered: z.array(valueSchema).optional() })
  .passthrough();
const snapshotSchema = z
  .object({ values: z.unknown(), next: z.array(z.string()), tasks: z.array(z.unknown()) })
  .passthrough();
const stageSchema = z
  .object({
    pid: z.number(),
    before: snapshotSchema.optional(),
    after: snapshotSchema,
    invoke: z
      .object({
        status: z.enum(['returned', 'threw']),
        value: z.unknown().optional(),
        error: z.unknown().optional(),
      })
      .optional(),
    checkpointCount: z.number(),
    namespaceHeads: z.array(z.unknown()),
  })
  .passthrough();
type Stage = import('zod').infer<typeof stageSchema>;
const eventSchema = z
  .object({
    event: z.string(),
    at: z.string(),
    pid: z.number(),
    index: z.number(),
    outerIndex: z.number(),
    node: z.string().optional(),
    activeCount: z.number().optional(),
    peakActiveCount: z.number().optional(),
    taskId: z.string().optional(),
    checkpointNs: z.string().optional(),
    nodeAttempt: z.number().optional(),
    decision: z.string().optional(),
  })
  .passthrough();

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function events(path: string) {
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => eventSchema.parse(JSON.parse(line)))
    : [];
}
function effects(path: string) {
  const counts: Record<string, number> = {};
  for (const event of events(path))
    if (event.event === 'stepA_effect') {
      const key = `${event.outerIndex}/${event.index}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  return counts;
}
function interrupts(snapshot: unknown, includeParentHistory = false): InterruptObservation[] {
  const found = new Map<string, InterruptObservation>();
  function visit(value: unknown) {
    const parsed = snapshotSchema.safeParse(value);
    if (!parsed.success) return;
    for (const task of parsed.data.tasks) {
      const candidate = z
        .object({ interrupts: z.array(interruptSchema), state: z.unknown().optional() })
        .passthrough()
        .safeParse(task);
      if (!candidate.success) continue;
      // 1.5.0 部分恢复后父 task 仍保留旧 interrupt；展开子图后，以叶级待执行任务为观察依据。
      const child = snapshotSchema.safeParse(candidate.data.state);
      if (includeParentHistory || !child.success)
        for (const interrupt of candidate.data.interrupts) found.set(interrupt.id, interrupt);
      if (child.success) visit(child.data);
    }
  }
  visit(snapshot);
  return [...found.values()].sort(
    (a, b) => a.value.outerIndex - b.value.outerIndex || a.value.index - b.value.index,
  );
}

async function launch(label: string, input: Omit<Request, 'outputPath'>): Promise<Stage> {
  const outputPath = join(evidence, `${label}.json`);
  const requestFile = join(evidence, `${label}.request.json`);
  writeJson(requestFile, { ...input, outputPath });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [join(experimentRoot, 'process.ts'), requestFile], {
      cwd: repositoryRoot,
      env: { PATH: process.env.PATH, DRAMAFLOW_RUNTIME_EXPERIMENT_DATABASE_URL: databaseUrl() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      writeJson(join(evidence, `${label}.process.json`), {
        pid: child.pid,
        code,
        signal,
        stdout,
        stderr,
      });
      if (code !== 0) reject(new Error(`实验子进程未正常退出：${label}，详见 process.json`));
      else resolve();
    });
  });
  return stageSchema.parse(readJson(outputPath));
}

const targetUrl = new URL(databaseUrl());
const adminUrl = new URL(targetUrl);
adminUrl.pathname = '/postgres';
const admin = new pg.Pool({ connectionString: adminUrl.href, connectionTimeoutMillis: 3000 });
let createdDatabase = false;
let postgresVersion = '';
try {
  const existing = await admin.query<{ datname: string }>(
    'SELECT datname FROM pg_database WHERE datname = $1',
    [databaseName],
  );
  if (existing.rowCount === 0) {
    await admin.query('CREATE DATABASE dramaflow_iteration_experiment');
    createdDatabase = true;
  }
  const version = await admin.query<{ version: string }>('SELECT version()');
  postgresVersion = version.rows[0]?.version ?? '';
} finally {
  await admin.end();
}
const setupSaver = openSaver();
try {
  await setupSaver.setup();
} finally {
  await setupSaver.end();
}

const summary: Record<string, unknown> = {
  runId,
  startedAt,
  versions,
  database: {
    host: targetUrl.hostname,
    port: targetUrl.port || '5432',
    name: databaseName,
    schema: 'langgraph',
    createdDatabase,
    postgresVersion,
  },
  lockfileSha256: createHash('sha256')
    .update(readFileSync(join(repositoryRoot, 'pnpm-lock.yaml')))
    .digest('hex'),
  experimentalSourceSha256: Object.fromEntries(
    ['dependencies.ts', 'graphs.ts', 'process.ts', 'repro-max-concurrency.ts', 'run.ts'].map(
      (file) => [
        file,
        createHash('sha256')
          .update(readFileSync(join(experimentRoot, file)))
          .digest('hex'),
      ],
    ),
  ),
};
const matrix: Record<string, unknown>[] = [];
const baseInput = (
  label: string,
  count: number,
  maxConcurrency: number,
  mode: Request['mode'] = 'basic',
) => ({
  operation: 'start' as const,
  mode,
  count,
  maxConcurrency,
  threadId: `iteration-experiment-${label}-${runId}`,
  eventPath: join(evidence, `${label}.events.jsonl`),
});
try {
  for (const maxConcurrency of [1, 2, 5])
    for (const count of [0, 1, 10, 100]) {
      const label = `basic-${count}-c${maxConcurrency}`;
      const input = baseInput(label, count, maxConcurrency);
      writeFileSync(input.eventPath, '');
      const stage = await launch(label, input);
      const values = stateValuesSchema.parse(stage.after.values);
      const ordered = values.ordered ?? [];
      const recorded = events(input.eventPath);
      const completionOrder = recorded
        .filter((event) => event.event === 'item_completed')
        .map((event) => event.index);
      const complete =
        stage.invoke?.status === 'returned' &&
        stage.after.next.length === 0 &&
        stage.after.tasks.length === 0 &&
        ordered.length === count;
      const correctOutput =
        complete &&
        ordered.every((value, index) => value.index === index && value.value === index * 2 + 1);
      const row = {
        count,
        maxConcurrency,
        invokeStatus: stage.invoke?.status,
        invokeError: stage.invoke?.error,
        complete,
        correctOutput,
        outputCount: ordered.length,
        uniqueCount: new Set(ordered.map((item) => item.index)).size,
        completedCount: completionOrder.length,
        completionOrder,
        peakActiveCount: Math.max(0, ...recorded.map((event) => event.peakActiveCount ?? 0)),
        stepAExecutionCount: effects(input.eventPath),
        next: stage.after.next,
        snapshotTaskCount: stage.after.tasks.length,
        evidence: `${label}.json`,
      };
      matrix.push(row);
      if (correctOutput) {
        assert.equal(completionOrder.length, count);
        assert.equal(new Set(completionOrder).size, count);
        assert.equal(Object.keys(row.stepAExecutionCount).length, count);
        assert(Object.values(row.stepAExecutionCount).every((value) => value === 1));
      }
      console.log(
        JSON.stringify({
          scenario: label,
          complete,
          correctOutput,
          peakActiveCount: row.peakActiveCount,
          completedCount: row.completedCount,
        }),
      );
    }
  summary.matrix = matrix;

  const repetitions = [];
  for (let repetition = 0; repetition < 2; repetition++) {
    const label = `order-repeat-${repetition}`;
    const input = baseInput(label, 10, 5);
    writeFileSync(input.eventPath, '');
    const stage = await launch(label, input);
    const values = stateValuesSchema.parse(stage.after.values);
    assert.deepEqual(
      values.ordered?.map((value) => value.index),
      Array.from({ length: 10 }, (_, index) => index),
    );
    repetitions.push({
      pid: stage.pid,
      completionOrder: events(input.eventPath)
        .filter((event) => event.event === 'item_completed')
        .map((event) => event.index),
      ordered: values.ordered,
    });
  }
  summary.orderRepetitions = repetitions;

  const repros = [];
  for (const storage of ['memory', 'postgres'] as const)
    for (const concurrency of [1, 2, 5]) {
      repros.push(await reproduce(concurrency, storage));
    }
  summary.minimalReproductions = repros;
  writeJson(join(evidence, 'minimal-reproductions.json'), repros);

  async function reviewScenario(
    label: string,
    mode: 'review' | 'nested',
    partial: boolean,
    maxConcurrency = 5,
  ) {
    const count = mode === 'nested' ? 2 : 3;
    const input = baseInput(label, count, maxConcurrency, mode);
    writeFileSync(input.eventPath, '');
    const first = await launch(`${label}-start`, input);
    assert.equal(first.invoke?.status, 'returned');
    const initialInterrupts = interrupts(first.after);
    assert.equal(initialInterrupts.length, mode === 'nested' ? 4 : 3);
    const countsBefore = effects(input.eventPath);
    assert.equal(Object.keys(countsBefore).length, initialInterrupts.length);
    assert(Object.values(countsBefore).every((value) => value === 1));
    const inspected = await launch(`${label}-new-process-inspect`, {
      ...input,
      operation: 'inspect',
    });
    assert.notEqual(first.pid, inspected.pid);
    assert.deepEqual(interrupts(inspected.after), initialInterrupts);
    const rounds: Record<string, unknown>[] = [];
    let previous = inspected;
    let pending = initialInterrupts;
    let round = 0;
    while (pending.length) {
      const selected = partial ? pending.slice(0, 1) : pending;
      const resume = Object.fromEntries(
        selected.map((item) => [item.id, `approve:${item.value.outerIndex}/${item.value.index}`]),
      );
      const next = await launch(`${label}-resume-${round}`, {
        ...input,
        operation: 'resume',
        resume,
      });
      assert.equal(next.invoke?.status, 'returned');
      assert.notEqual(previous.pid, next.pid);
      const remaining = interrupts(next.after);
      assert.deepEqual(effects(input.eventPath), countsBefore);
      const resumed = events(input.eventPath).filter((event) => event.event === 'review_resumed');
      for (const item of selected)
        assert(
          resumed.some(
            (event) =>
              event.index === item.value.index &&
              event.outerIndex === item.value.outerIndex &&
              event.decision === resume[item.id],
          ),
        );
      rounds.push({
        pid: next.pid,
        resume,
        invoke: next.invoke,
        remainingInterrupts: remaining,
        snapshotInterruptsIncludingParentHistory: interrupts(next.after, true),
        completedItems: events(input.eventPath)
          .filter((event) => event.event === 'item_completed')
          .map((event) => `${event.outerIndex}/${event.index}`),
        stepAExecutionCount: effects(input.eventPath),
        next: next.after.next,
        snapshotTaskCount: next.after.tasks.length,
      });
      assert.equal(remaining.length, pending.length - selected.length);
      assert.deepEqual(
        remaining,
        pending.filter((item) => !selected.some((target) => target.id === item.id)),
      );
      previous = next;
      pending = remaining;
      round++;
      assert(round <= 4);
    }
    const values = stateValuesSchema.parse(previous.after.values);
    assert.equal(values.ordered?.length, initialInterrupts.length);
    assert.equal(previous.after.tasks.length, 0);
    assert.equal(previous.after.next.length, 0);
    for (const value of values.ordered ?? []) {
      const inputValue = mode === 'nested' ? value.outerIndex * 10 + value.index : value.index;
      assert.equal(value.value, inputValue * 2 + 1);
      assert.equal(value.decision, `approve:${value.outerIndex}/${value.index}`);
    }
    const completed = events(input.eventPath)
      .filter((event) => event.event === 'item_completed')
      .map((event) => `${event.outerIndex}/${event.index}`);
    const wrapperCompletionCounts: Record<string, number> = {};
    for (const key of completed)
      wrapperCompletionCounts[key] = (wrapperCompletionCounts[key] ?? 0) + 1;
    const stepBExecutionCounts: Record<string, number> = {};
    for (const event of events(input.eventPath))
      if (event.event === 'node_started' && event.node === 'stepB') {
        const key = `${event.outerIndex}/${event.index}`;
        stepBExecutionCounts[key] = (stepBExecutionCounts[key] ?? 0) + 1;
      }
    assert.equal(new Set(completed).size, initialInterrupts.length);
    assert(Object.values(stepBExecutionCounts).every((count) => count === 1));
    if (mode !== 'nested') assert.equal(new Set(completed).size, completed.length);
    return {
      mode,
      partial,
      maxConcurrency,
      startPid: first.pid,
      inspectPid: inspected.pid,
      initialInterrupts,
      startInvoke: first.invoke,
      namespaceHeads: first.namespaceHeads,
      rounds,
      finalOrdered: values.ordered,
      stepAExecutionCount: effects(input.eventPath),
      wrapperCompletionCounts,
      stepBExecutionCounts,
      peakActiveCount: Math.max(
        0,
        ...events(input.eventPath).map((event) => event.peakActiveCount ?? 0),
      ),
      reviewEnterCounts: events(input.eventPath).filter((event) => event.event === 'review_enter'),
      runtimeIdentities: events(input.eventPath).filter((event) =>
        ['body_started', 'stepA_effect', 'review_enter', 'outer_enter'].includes(event.event),
      ),
    };
  }
  const partial = await reviewScenario('review-partial', 'review', true);
  summary.partialResume = partial;
  console.log('review-partial completed');
  const all = await reviewScenario('review-all', 'review', false);
  summary.allResume = all;
  assert.deepEqual(partial.finalOrdered, all.finalOrdered);
  console.log('review-all completed');
  summary.nested = await reviewScenario('nested-partial', 'nested', true, 2);
  console.log('nested-partial completed');
  summary.completedAt = new Date().toISOString();
  summary.harnessStatus = 'completed';
  summary.nonConcurrencyOneMatrixPassed = matrix
    .filter((row) => row.maxConcurrency !== 1)
    .every((row) => row.correctOutput === true);
  assert.equal(summary.nonConcurrencyOneMatrixPassed, true);
  summary.concurrencyOneAnomalyObserved = matrix
    .filter((row) => row.maxConcurrency === 1 && Number(row.count) > 1)
    .every((row) => row.completedCount === 1 && row.complete === false);
} catch (error) {
  summary.matrix = matrix;
  summary.harnessStatus = 'failed';
  summary.failure =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : String(error);
  process.exitCode = 1;
} finally {
  writeJson(join(evidence, 'summary.json'), summary);
  console.log(
    JSON.stringify({
      harnessStatus: summary.harnessStatus,
      summary: join(evidence, 'summary.json'),
    }),
  );
}
