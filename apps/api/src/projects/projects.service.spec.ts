import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { encodeProjectPageCursor } from '@dramaflow/contracts';
import { DatabaseService } from '@dramaflow/server';
import { ProjectsService } from './projects.service.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const ownerId = 'owner-a';
const viewport = { x: 10, y: -20, zoom: 1.5 };
const timestamp = new Date('2026-10-19T00:00:00.000Z');
const summary = {
  id: projectId,
  name: '第一集',
  revision: 3,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const record = { ...summary, ownerId, viewport };
const saveInput = { name: '修改后的项目', revision: 3, viewport };

async function setup() {
  // 仅在测试中替换数据库；生产服务始终使用真实 DatabaseService。
  const project = {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(record),
    create: vi.fn().mockResolvedValue(record),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const module = await Test.createTestingModule({
    providers: [
      { provide: DatabaseService, useValue: { client: { project } } },
      {
        provide: ProjectsService,
        useFactory: (db: DatabaseService) => new ProjectsService(db),
        inject: [DatabaseService],
      },
    ],
  }).compile();
  return { service: module.get(ProjectsService), project };
}

describe('基础项目与所有者隔离', () => {
  it('创建归属当前所有者的项目，并原子初始化视口和默认工作流', async () => {
    const { service, project } = await setup();
    const result = await service.create(ownerId, { name: ' 第一集 ' });
    expect(project.create).toHaveBeenCalledWith({
      data: {
        ownerId,
        name: '第一集',
        viewport: { x: 0, y: 0, zoom: 1 },
        workflow: {
          create: {
            name: '默认工作流',
            draft: { inputs: [], nodes: [], edges: [], outputs: [] },
          },
        },
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
      viewport,
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
    });
  });

  it('不存在或属于其他所有者的项目统一返回 404', async () => {
    const { service, project } = await setup();
    project.findFirst.mockResolvedValue(null);
    await expect(service.get('owner-b', projectId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
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
      await expect(service.list(ownerId, query)).rejects.toBeInstanceOf(
        z.ZodError,
      );
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
      data: { name: saveInput.name, viewport, revision: { increment: 1 } },
    });
    expect(project.findFirst).not.toHaveBeenCalled();
  });

  it('相同修订号并发保存时，仅成功写入者返回新修订号，另一方收到 409', async () => {
    const { service, project } = await setup();
    project.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
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
    await expect(
      service.save('owner-b', projectId, saveInput),
    ).rejects.toBeInstanceOf(NotFoundException);
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
    await expect(
      service.create(ownerId, { name: '第一集', ...extra }),
    ).rejects.toBeInstanceOf(z.ZodError);
    await expect(
      service.save(ownerId, projectId, { ...saveInput, ...extra }),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(project.create).not.toHaveBeenCalled();
    expect(project.updateMany).not.toHaveBeenCalled();
  });
});
