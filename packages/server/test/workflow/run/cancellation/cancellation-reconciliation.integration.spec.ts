import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../../../../src/database/database.service.js';
import { WorkflowRunRepositories } from '../../../../src/workflow/run/repository/workflow-run-repository.js';
import { NodeRunRepositories } from '../../../../src/workflow/runtime/execution/node-run-repository.js';
import { WorkflowRunQueryService } from '../../../../src/workflow/run/query/workflow-run-query.service.js';
import { WorkflowCancellationReconciler } from '../../../../src/workflow/queue/workflow-cancellation-reconciler.js';
import {
  WorkflowExecutionQueue,
  createWorkflowExecutionWorker,
} from '../../../../src/workflow/queue/workflow-execution-queue.js';
import { WorkflowExecutionService } from '../../../../src/workflow/runtime/workflow-execution.service.js';
import type { WorkflowRuntimeFactory } from '../../../../src/workflow/runtime/workflow-runtime.factory.js';

const enabled = process.env.DRAMAFLOW_INTEGRATION === '1';
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/dramaflow_test')
    throw Error('仅限本机 dramaflow_test');
}
describe.skipIf(!enabled)('取消 reconciliation / PostgreSQL + Redis 证据', () => {
  const database = enabled ? new DatabaseService() : undefined;
  const db = () => database!.client;
  const owner = randomUUID();
  let queue: WorkflowExecutionQueue;
  let previous: string | undefined;
  const runs = () => new WorkflowRunRepositories(database!);
  const query = () => new WorkflowRunQueryService(database!);
  const reconciler = () => new WorkflowCancellationReconciler(database!, queue, runs());
  beforeAll(async () => {
    const redis = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
    if (!['localhost', '127.0.0.1'].includes(redis.hostname)) throw Error('仅限本机 Redis');
    previous = process.env.WORKFLOW_QUEUE_PREFIX;
    process.env.WORKFLOW_QUEUE_PREFIX = `dramaflow-test-reconcile-${randomUUID()}`;
    queue = new WorkflowExecutionQueue();
    await queue.queue.waitUntilReady();
    await db().user.create({
      data: { id: owner, name: '核查测试', email: `${owner}@example.test` },
    });
  });
  afterAll(async () => {
    if (!database) return;
    await db().user.deleteMany({ where: { id: owner } });
    await queue.queue.obliterate({ force: true });
    await queue.onModuleDestroy();
    if (previous === undefined) delete process.env.WORKFLOW_QUEUE_PREFIX;
    else process.env.WORKFLOW_QUEUE_PREFIX = previous;
    await database.onModuleDestroy();
  });
  async function fixture() {
    const project = await db().project.create({
      data: { ownerId: owner, name: '取消核查', viewport: {} },
    });
    const workflow = await db().workflow.create({
      data: { projectId: project.id, name: '核查', draft: {} },
    });
    const repository = await runs().forProject(owner, project.id);
    const { run } = await repository.createWithExecution({
      projectId: project.id,
      workflowId: workflow.id,
      workflowVersionId: 'version',
      invocationKey: randomUUID(),
      inputs: {},
    });
    const job = { kind: 'start' as const, workflowRunId: run.id };
    const intent = await db().workflowExecutionOutbox.findFirstOrThrow({
      where: { workflowRunId: run.id },
    });
    const worker = await runs().forProject(owner, project.id, intent.id);
    const facts = async () => ({
      run: await db().workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
      intent: await db().workflowExecutionOutbox.findUniqueOrThrow({ where: { id: intent.id } }),
      nodes: await db().nodeRun.findMany({ where: { workflowRunId: run.id } }),
      children: await db().childExecution.findMany({ where: { workflowRunId: run.id } }),
    });
    return { project, workflow, repository, worker, run, intent, job, facts };
  }
  it('已 claim 后 Job 丢失：升为 recovery，Run/Node/Child 不伪造 cancelled；GET 与 History 共用 projection', async () => {
    const f = await fixture();
    await f.worker.claimPendingForStart(f.run.id);
    const nodes = await new NodeRunRepositories(database!).forRun(owner, f.project.id, f.run.id);
    const occurrence = await nodes.getOrCreateOccurrence({
      workflowRunId: f.run.id,
      nodeId: 'sub',
      scopeKey: 'root',
    });
    const parent = await nodes.createRunning({
      workflowRunId: f.run.id,
      nodeId: 'sub',
      occurrenceId: occurrence.id,
    });
    await nodes.getOrCreateChildExecutionRunning({
      workflowRunId: f.run.id,
      parentNodeRunId: parent.id,
      parentNodeId: 'sub',
      scopeKey: randomUUID(),
      kind: 'subworkflow',
      invocationKey: 'subworkflow:graph',
      metadata: {},
    });
    await f.repository.requestCancellation(f.run.id);
    expect((await query().getRun(owner, f.run.id)).cancellation).toBe('requested');
    const before = await f.facts();
    await reconciler().reconcile(f.run.id); // Redis 中根本不存在该 Job。
    const after = await f.facts();
    expect(after.run).toEqual(before.run);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.children).toEqual(before.children);
    expect(after.intent.status).toBe('recovery_required');
    const detail = await query().getRun(owner, f.run.id);
    const history = await query().listRuns(owner, f.project.id, f.workflow.id, {});
    expect(detail).toMatchObject({ status: 'running', cancellation: 'uncertain' });
    expect(history.items[0]!.cancellation).toBe(detail.cancellation);
    expect(detail).not.toHaveProperty('executions');
    expect(history.items[0]).not.toHaveProperty('waitingRevision');
    const forProject = vi.fn();
    await expect(
      new WorkflowExecutionService(database!, {
        forProject,
      } as unknown as WorkflowRuntimeFactory).execute(f.job),
    ).rejects.toMatchObject({ code: 'WORKFLOW_EXECUTION_RECOVERY_REQUIRED' });
    expect(forProject).not.toHaveBeenCalled();
    expect(await f.worker.claimPendingForStart(f.run.id)).toBeNull();
  });
  it.each(['completed', 'failed', 'cancelled'] as const)(
    '核查后 late %s 真实事实可以终结；再次核查只补 Outbox，不覆盖 Run',
    async (status) => {
      const f = await fixture();
      await f.worker.claimPendingForStart(f.run.id);
      await f.repository.requestCancellation(f.run.id);
      const reconciliation = reconciler();
      await reconciliation.reconcile(f.run.id);
      if (status === 'completed') await f.repository.markCompleted(f.run.id, {});
      else if (status === 'failed')
        await f.repository.markFailed(f.run.id, { stage: 'execute', message: '真实业务事实' });
      else await f.repository.markCancelled(f.run.id); // 此 fixture 未启动 graph；确认当前没有本地 invocation。
      const terminal = (await f.facts()).run;
      await reconciliation.reconcile(f.run.id);
      expect((await f.facts()).run).toEqual(terminal);
      expect((await f.facts()).intent.status).toBe(status);
      expect((await query().getRun(owner, f.run.id)).cancellation).toBe('none');
    },
  );
  it('Redis 不可读也只能 uncertain；核查期间的 late completed 优先', async () => {
    const f = await fixture();
    await f.worker.claimPendingForStart(f.run.id);
    await f.repository.requestCancellation(f.run.id);
    const evidence = vi.spyOn(queue, 'hasActiveExecutionEvidence').mockImplementation(async () => {
      await f.repository.markCompleted(f.run.id, {});
      return false;
    });
    try {
      await reconciler().reconcile(f.run.id);
    } finally {
      evidence.mockRestore();
    }
    expect((await f.facts()).run.status).toBe('completed');
    expect((await f.facts()).intent.status).toBe('completed');
  });
  it('历史 start recovery 不污染当前 resume，也不被改写', async () => {
    const f = await fixture();
    await f.worker.claimPendingForStart(f.run.id);
    await f.repository.markWaiting(f.run.id);
    await db().workflowExecutionOutbox.update({
      where: { id: f.intent.id },
      data: { status: 'recovery_required', completedAt: new Date() },
    });
    const job = await f.repository.createResumeExecution({ workflowRunId: f.run.id, value: {} });
    const worker = await runs().forProject(owner, f.project.id, job.executionId);
    await worker.claimWaitingForResume(f.run.id);
    await f.repository.requestCancellation(f.run.id);
    expect((await query().getRun(owner, f.run.id)).cancellation).toBe('requested');
    await reconciler().reconcile(f.run.id);
    expect(
      (await db().workflowExecutionOutbox.findUniqueOrThrow({ where: { id: job.executionId } }))
        .status,
    ).toBe('recovery_required');
    expect((await f.facts()).intent.status).toBe('recovery_required');
    expect((await query().getRun(owner, f.run.id)).cancellation).toBe('uncertain');
  });
  it('有锁 active 仅暂缓核查；Redis 观察失败也不宣称执行已停止', async () => {
    const f = await fixture();
    await f.worker.claimPendingForStart(f.run.id);
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = createWorkflowExecutionWorker(async () => {
      started();
      await finished;
    });
    const running = worker.run();
    try {
      await queue.publish(f.job);
      await entered;
      await f.repository.requestCancellation(f.run.id);
      expect(await queue.hasActiveExecutionEvidence(f.job)).toBe(true);
      await reconciler().reconcile(f.run.id);
      expect((await f.facts()).intent.status).toBe('executing');
      expect((await query().getRun(owner, f.run.id)).cancellation).toBe('requested');
      const read = vi.spyOn(queue.queue, 'getJob').mockRejectedValue(Error('redis unavailable'));
      try {
        await reconciler().reconcile(f.run.id);
      } finally {
        read.mockRestore();
      }
      expect((await f.facts()).run.status).toBe('running');
      expect((await f.facts()).intent.status).toBe('recovery_required');
      expect((await query().getRun(owner, f.run.id)).cancellation).toBe('uncertain');
    } finally {
      release();
      await worker.close();
      await running;
    }
  });
  it('候选宽限期只控制扫描；未 claim 的 Run 走既有取消事务', async () => {
    const f = await fixture();
    await db().workflowRun.update({
      where: { id: f.run.id },
      data: { cancellationRequestedAt: new Date() },
    });
    const reconciliation = reconciler();
    await reconciliation.reconcileBatch();
    expect((await f.facts()).run.status).toBe('pending');
    // 每轮有界且游标公平；同一测试库可同时存在其他 cancellation candidate。
    for (let i = 0; i < 20 && (await f.facts()).run.status === 'pending'; i++)
      await reconciliation.reconcileBatch(new Date(Date.now() + 31000));
    expect((await f.facts()).run).toMatchObject({ status: 'cancelled', startedAt: null });
    expect((await f.facts()).intent.status).toBe('cancelled');
  });
});
