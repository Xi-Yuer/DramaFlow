import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../../../src/database/database.service.js';
import { WorkflowRunRepositories } from '../../../../src/workflow/run/repository/workflow-run-repository.js';
import { WorkflowRunQueryService } from '../../../../src/workflow/run/query/workflow-run-query.service.js';
import { WorkflowRunCancellationService } from '../../../../src/workflow/run/cancellation/workflow-run-cancellation.service.js';
const enabled = process.env.DRAMAFLOW_INTEGRATION === '1';
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/dramaflow_test')
    throw Error('仅允许本机测试库');
}
describe.skipIf(!enabled)('Cancel 产品 service → 正式 PostgreSQL transaction / read model', () => {
  const db = enabled ? new DatabaseService() : undefined;
  const owner = randomUUID();
  const repositories = () => new WorkflowRunRepositories(db!);
  const service = () =>
    new WorkflowRunCancellationService(db!, repositories(), new WorkflowRunQueryService(db!));
  beforeAll(async () => {
    await db!.client.user.create({
      data: { id: owner, name: 'Cancel 产品测试', email: `${owner}@example.test` },
    });
  });
  afterAll(async () => {
    if (db) {
      await db.client.user.deleteMany({ where: { id: owner } });
      await db.onModuleDestroy();
    }
  });
  async function fixture() {
    const project = await db!.client.project.create({
      data: { ownerId: owner, name: 'Cancel', viewport: {} },
    });
    const workflow = await db!.client.workflow.create({
      data: { projectId: project.id, name: 'Cancel', draft: {} },
    });
    const repository = await repositories().forProject(owner, project.id);
    const { run } = await repository.createWithExecution({
      projectId: project.id,
      workflowId: workflow.id,
      workflowVersionId: 'version',
      invocationKey: randomUUID(),
      inputs: {},
    });
    return {
      project,
      workflow,
      run,
      repository,
      cancel: () => service().cancel(owner, project.id, workflow.id, run.id, {}),
    };
  }
  it('pending 幂等取消且 startedAt 保持为空，返回安全读模型', async () => {
    const f = await fixture();
    const first = await f.cancel();
    expect(first).toMatchObject({
      outcome: 'cancelled',
      run: { status: 'cancelled', cancellation: 'none' },
    });
    expect(first.run).not.toHaveProperty('startedAt');
    expect(first.run).not.toHaveProperty('threadId');
    expect(await f.cancel()).toEqual(first);
  });
  it.each(['completed', 'failed'] as const)(
    'running 请求保持 running；later %s 不被重复取消覆盖',
    async (status) => {
      const f = await fixture();
      await f.repository.claimPendingForStart(f.run.id);
      const requested = await f.cancel();
      expect(requested).toMatchObject({
        outcome: 'requested',
        run: { status: 'running', cancellation: 'requested' },
      });
      expect(await f.cancel()).toEqual(requested);
      if (status === 'completed') await f.repository.markCompleted(f.run.id, {});
      else await f.repository.markFailed(f.run.id, { stage: 'execute', message: '真实失败' });
      expect(await f.cancel()).toMatchObject({
        outcome: 'terminal',
        run: { status, cancellation: 'none' },
      });
    },
  );
  it('错误 owner / Project / Workflow / Run 均不能写取消意图', async () => {
    const f = await fixture();
    const product = service();
    for (const args of [
      ['outsider', f.project.id, f.workflow.id, f.run.id],
      [owner, randomUUID(), f.workflow.id, f.run.id],
      [owner, f.project.id, 'wrong-workflow', f.run.id],
      [owner, f.project.id, f.workflow.id, 'wrong-run'],
    ] as const)
      await expect(product.cancel(args[0], args[1], args[2], args[3], {})).rejects.toMatchObject({
        status: 404,
      });
    expect((await f.repository.getById(f.run.id))!.cancellationRequestedAt).toBeUndefined();
  });
});
