import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { encodeProjectPageCursor } from '@dramaflow/contracts';
import {
  DatabaseService,
  StorageService,
  WorkflowCheckpointerService,
  WorkflowExecutionQueue,
} from '@dramaflow/server';
import { ProjectsService } from './projects.service.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const ownerId = 'owner-a';
const timestamp = new Date('2026-10-19T00:00:00.000Z');
const summary = {
  id: projectId,
  name: '第一集',
  revision: 3,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const record = { ...summary, ownerId };
const saveInput = { name: '修改后的项目', revision: 3 };

async function setup() {
  // 仅在测试中替换数据库和外部清理；生产服务始终使用真实实现。
  const project = {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(record),
    create: vi.fn().mockResolvedValue(record),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    delete: vi.fn().mockResolvedValue(record),
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: projectId }]),
    artifact: { findMany: vi.fn().mockResolvedValue([]) },
    workflowRun: { findMany: vi.fn().mockResolvedValue([]) },
    project,
  };
  const client = {
    project,
    $transaction: vi.fn((callback: (current: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const storage = { delete: vi.fn().mockResolvedValue(undefined) };
  const checkpoints = { deleteThread: vi.fn().mockResolvedValue(undefined) };
  const queue = { remove: vi.fn().mockResolvedValue(undefined) };
  const module = await Test.createTestingModule({
    providers: [
      { provide: DatabaseService, useValue: { client } },
      { provide: StorageService, useValue: storage },
      { provide: WorkflowCheckpointerService, useValue: checkpoints },
      { provide: WorkflowExecutionQueue, useValue: queue },
      {
        provide: ProjectsService,
        useFactory: (
          db: DatabaseService,
          files: StorageService,
          threads: WorkflowCheckpointerService,
          jobs: WorkflowExecutionQueue,
        ) => new ProjectsService(db, files, threads, jobs),
        inject: [
          DatabaseService,
          StorageService,
          WorkflowCheckpointerService,
          WorkflowExecutionQueue,
        ],
      },
    ],
  }).compile();
  return {
    service: module.get(ProjectsService),
    project,
    tx,
    storage,
    checkpoints,
    queue,
  };
}

describe('基础项目与所有者隔离', () => {
  it('创建归属当前所有者的项目，从空 Workspace 开始', async () => {
    const { service, project } = await setup();
    const result = await service.create(ownerId, { name: ' 第一集 ' });
    expect(project.create).toHaveBeenCalledWith({
      data: {
        ownerId,
        name: '第一集',
      },
    });
    expect(result).not.toHaveProperty('ownerId');
    expect(result).not.toHaveProperty('definition');
    expect(result).not.toHaveProperty('nodeCount');
  });

  it('查询只读取当前所有者的项目，响应不暴露内部字段', async () => {
    const { service, project } = await setup();
    const result = await service.get(ownerId, projectId);
    expect(project.findFirst).toHaveBeenCalledWith({
      where: { id: projectId, ownerId },
    });
    expect(result).toEqual({
      ...summary,
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
    });
  });

  it('不存在或属于其他所有者的项目统一返回 404', async () => {
    const { service, project } = await setup();
    project.findFirst.mockResolvedValue(null);
    await expect(service.get('owner-b', projectId)).rejects.toBeInstanceOf(NotFoundException);
    expect(project.findFirst).toHaveBeenCalledWith({
      where: { id: projectId, ownerId: 'owner-b' },
    });
  });

  it('分页按更新时间倒序，并以最后一条的时间与 id 作为下一页游标', async () => {
    const { service, project } = await setup();
    const cursor = encodeProjectPageCursor({
      updatedAt: timestamp.toISOString(),
      id: '00000000-0000-4000-8000-000000000099',
    });
    const records = Array.from({ length: 31 }, (_, index) => ({
      ...summary,
      id: `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
      updatedAt: new Date(timestamp.getTime() - index * 1000),
    }));
    project.findMany.mockResolvedValue(records);
    const result = await service.list(ownerId, { cursor });
    expect(project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ownerId,
          OR: [
            { updatedAt: { lt: timestamp } },
            {
              updatedAt: timestamp,
              id: { lt: '00000000-0000-4000-8000-000000000099' },
            },
          ],
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 31,
      }),
    );
    expect(result.items).toHaveLength(30);
    expect(result.nextCursor).toBe(
      encodeProjectPageCursor({
        updatedAt: records[29]!.updatedAt.toISOString(),
        id: records[29]!.id,
      }),
    );
  });

  it('首页和最后一页始终限定所有者，不为不足一页的结果制造游标', async () => {
    const { service, project } = await setup();
    project.findMany.mockResolvedValue([summary]);
    const result = await service.list(ownerId, {});
    expect(project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerId },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(result.items.map((item) => item.id)).toEqual([projectId]);
    expect(result.nextCursor).toBeNull();
    project.findMany.mockResolvedValue([]);
    expect(await service.list(ownerId, {})).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('游标无效时不查询数据库', async () => {
    const { service, project } = await setup();
    for (const query of [
      { cursor: 'not-base64' },
      { cursor: 'a'.repeat(257) },
      { cursor: ['a', 'b'] },
      { ownerId: 'other-owner' },
    ]) {
      await expect(service.list(ownerId, query)).rejects.toBeInstanceOf(z.ZodError);
    }
    expect(project.findMany).not.toHaveBeenCalled();
  });

  it('保存通过所有者和修订号原子更新，并返回本次写入的修订号', async () => {
    const { service, project } = await setup();
    await expect(service.save(ownerId, projectId, saveInput)).resolves.toEqual({
      revision: 4,
    });
    expect(project.updateMany).toHaveBeenCalledWith({
      where: { id: projectId, ownerId, revision: 3 },
      data: { name: saveInput.name, revision: { increment: 1 } },
    });
    expect(project.findFirst).not.toHaveBeenCalled();
  });

  it('相同修订号并发保存时，仅成功写入者返回新修订号，另一方收到 409', async () => {
    const { service, project } = await setup();
    project.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const results = await Promise.allSettled([
      service.save(ownerId, projectId, saveInput),
      service.save(ownerId, projectId, saveInput),
    ]);
    expect(results[0]).toEqual({ status: 'fulfilled', value: { revision: 4 } });
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: expect.any(ConflictException),
    });
    expect(project.updateMany).toHaveBeenCalledTimes(2);
    expect(project.findFirst).toHaveBeenCalledWith({
      where: { id: projectId, ownerId },
    });
  });

  it('其他所有者保存失败时返回 404，不暴露项目修订号', async () => {
    const { service, project } = await setup();
    project.updateMany.mockResolvedValue({ count: 0 });
    project.findFirst.mockResolvedValue(null);
    await expect(service.save('owner-b', projectId, saveInput)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(project.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: projectId, ownerId: 'owner-b', revision: 3 },
      }),
    );
  });

  it.each([
    { definition: { schemaVersion: 1, nodes: [], edges: [], bindings: [] } },
    { nodeCount: 0 },
    { ownerId: 'owner-b' },
  ])('拒绝创建或保存请求中的旧业务字段和所有者注入：%o', async (extra) => {
    const { service, project } = await setup();
    await expect(service.create(ownerId, { name: '第一集', ...extra })).rejects.toBeInstanceOf(
      z.ZodError,
    );
    await expect(
      service.save(ownerId, projectId, { ...saveInput, ...extra }),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(project.create).not.toHaveBeenCalled();
    expect(project.updateMany).not.toHaveBeenCalled();
  });

  it('删除项目时级联数据库记录，并清理素材、Checkpoint 和队列任务', async () => {
    const { service, project, tx, storage, checkpoints, queue } = await setup();
    const runId = '00000000-0000-4000-8000-000000000041';
    const executionId = '00000000-0000-4000-8000-000000000042';
    tx.artifact.findMany.mockResolvedValue([
      { storageKey: 'runs/a.bin' },
      { storageKey: 'runs/b.bin' },
    ]);
    tx.workflowRun.findMany.mockResolvedValue([
      {
        id: runId,
        threadId: 'thread-1',
        executions: [
          { payload: { kind: 'start', workflowRunId: runId } },
          {
            payload: {
              kind: 'resume',
              workflowRunId: runId,
              executionId,
              value: { approved: true },
            },
          },
        ],
      },
    ]);
    await service.remove(ownerId, projectId);
    expect(project.delete).toHaveBeenCalledWith({ where: { id: projectId } });
    expect(storage.delete).toHaveBeenCalledTimes(2);
    expect(storage.delete).toHaveBeenNthCalledWith(1, 'runs/a.bin');
    expect(storage.delete).toHaveBeenNthCalledWith(2, 'runs/b.bin');
    expect(checkpoints.deleteThread).toHaveBeenCalledWith('thread-1');
    expect(queue.remove).toHaveBeenCalledWith({
      kind: 'start',
      workflowRunId: runId,
    });
    expect(queue.remove).toHaveBeenCalledWith({
      kind: 'resume',
      workflowRunId: runId,
      executionId,
      value: { approved: true },
    });
  });

  it('其他所有者或未知项目删除时返回 404，不清理外部对象', async () => {
    const { service, project, tx, storage, checkpoints, queue } = await setup();
    tx.$queryRaw.mockResolvedValue([]);
    await expect(service.remove('owner-b', projectId)).rejects.toBeInstanceOf(NotFoundException);
    expect(project.delete).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(checkpoints.deleteThread).not.toHaveBeenCalled();
    expect(queue.remove).not.toHaveBeenCalled();
  });

  it('数据库删除成功但素材清理失败时说明项目已删除', async () => {
    const { service, project, tx, storage } = await setup();
    tx.artifact.findMany.mockResolvedValue([{ storageKey: 'runs/a.bin' }]);
    storage.delete.mockRejectedValue(new Error('storage'));
    await expect(service.remove(ownerId, projectId)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(project.delete).toHaveBeenCalledWith({ where: { id: projectId } });
  });

  it('无效项目标识不开启删除事务', async () => {
    const { service, tx } = await setup();
    await expect(service.remove(ownerId, 'not-a-uuid')).rejects.toBeInstanceOf(z.ZodError);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
