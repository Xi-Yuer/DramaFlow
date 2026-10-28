import type { Prisma } from '@dramaflow/database';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunQueryService } from '../src/workflow/run/query/workflow-run-query.service.js';
import type { DatabaseService } from '../src/database/database.service.js';
import { encodeWorkflowRunCursor } from '@dramaflow/contracts';
const projectId = '00000000-0000-4000-8000-000000000001';
function fixture(authorized = true) {
  const client = {
    workflow: { findFirst: vi.fn().mockResolvedValue(authorized ? { id: 'workflow' } : null) },
    workflowRun: { findMany: vi.fn(async (_query: Prisma.WorkflowRunFindManyArgs) => []) },
    workflowVersion: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const service = new WorkflowRunQueryService({ client } as unknown as DatabaseService);
  return { client, service };
}
describe('授权 WorkflowRun 历史查询', () => {
  it('每次查询限定 owner / project / workflow，只选择公开摘要列，空列表不查询版本或 Draft', async () => {
    const f = fixture();
    expect(await f.service.listRuns('owner', projectId, 'workflow', {})).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(f.client.workflow.findFirst).toHaveBeenCalledWith({
      where: { id: 'workflow', projectId, project: { ownerId: 'owner' } },
      select: { id: true },
    });
    const query = f.client.workflowRun.findMany.mock.calls[0]![0];
    expect(query.where).toEqual({
      workflowId: 'workflow',
      projectId,
      project: { ownerId: 'owner' },
    });
    expect(query.select).not.toHaveProperty('threadId');
    expect(query.select).not.toHaveProperty('inputs');
    expect(query.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(f.client.workflowVersion.findMany).not.toHaveBeenCalled();
  });
  it('无权访问不读取任何 Run；无效 cursor 不进入数据库', async () => {
    const f = fixture(false);
    await expect(
      f.service.listRuns('other-owner', projectId, 'workflow', {}),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.client.workflowRun.findMany).not.toHaveBeenCalled();
    f.client.workflow.findFirst.mockClear();
    await expect(
      f.service.listRuns('owner', projectId, 'workflow', { cursor: 'A' }),
    ).rejects.toThrow();
    expect(f.client.workflow.findFirst).not.toHaveBeenCalled();
  });
  it('cursor 使用严格小于的联合边界，不依赖记录仍存在', async () => {
    const f = fixture();
    const createdAt = '2026-10-28T00:00:00.000Z';
    await f.service.listRuns('owner', projectId, 'workflow', {
      cursor: encodeWorkflowRunCursor({ createdAt, id: 'removed-run' }),
    });
    expect(f.client.workflowRun.findMany.mock.calls[0]![0].where!.OR).toEqual([
      { createdAt: { lt: new Date(createdAt) } },
      { createdAt: new Date(createdAt), id: { lt: 'removed-run' } },
    ]);
  });
});
