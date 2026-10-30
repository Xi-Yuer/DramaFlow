import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DatabaseService } from '@dramaflow/server';
import { decodeVideoPageCursor } from '@dramaflow/contracts';
import { VideosService } from './videos.service.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const ownerId = 'owner-a';
const record = {
  id,
  projectId,
  name: '雨夜来信',
  status: 'draft',
  revision: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};
async function setup() {
  const video = {
    create: vi.fn().mockResolvedValue(record),
    findMany: vi.fn().mockResolvedValue([record]),
    findFirst: vi.fn().mockResolvedValue(record),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const project = { findFirst: vi.fn().mockResolvedValue({ id: projectId }) };
  const tx = { $queryRaw: vi.fn().mockResolvedValue([{ id: projectId }]), video };
  const client = {
    video,
    project,
    $transaction: vi.fn((callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const module = await Test.createTestingModule({
    providers: [
      { provide: DatabaseService, useValue: { client } },
      {
        provide: VideosService,
        useFactory: (db: DatabaseService) => new VideosService(db),
        inject: [DatabaseService],
      },
    ],
  }).compile();
  return { service: module.get(VideosService), video, project, tx, client };
}

describe('Video 应用服务与项目边界', () => {
  it('按所有者锁定项目后只创建基础作品身份', async () => {
    const { service, video, tx } = await setup();
    const result = await service.create(ownerId, projectId, { name: ' 雨夜来信 ' });
    expect(tx.$queryRaw.mock.calls[0]?.slice(1)).toEqual([projectId, ownerId]);
    expect(video.create).toHaveBeenCalledExactlyOnceWith({ data: { projectId, name: '雨夜来信' } });
    expect(result).toMatchObject({ id, projectId, status: 'draft', revision: 1 });
  });
  it('缺失或越权 Project 不创建作品，列表也不伪造空成功', async () => {
    const { service, video, tx, project } = await setup();
    tx.$queryRaw.mockResolvedValue([]);
    project.findFirst.mockResolvedValue(null);
    await expect(service.create('other', projectId, { name: '作品' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.list('other', projectId, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(video.create).not.toHaveBeenCalled();
    expect(video.findMany).not.toHaveBeenCalled();
  });
  it('项目内列表同时按项目与所有者过滤，并按创建时间分页', async () => {
    const { service, video, project } = await setup();
    video.findMany.mockResolvedValue(
      Array.from({ length: 31 }, (_, index) => ({
        ...record,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      })),
    );
    const result = await service.list(ownerId, projectId, {});
    expect(project.findFirst).toHaveBeenCalledWith({
      where: { id: projectId, ownerId },
      select: { id: true },
    });
    expect(video.findMany).toHaveBeenCalledWith({
      where: { projectId, project: { ownerId } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 31,
    });
    expect(result.items).toHaveLength(30);
    expect(decodeVideoPageCursor(result.nextCursor!)).toEqual({
      id: result.items[29]!.id,
      createdAt: record.createdAt.toISOString(),
    });
    await service.list(ownerId, projectId, { cursor: result.nextCursor });
    expect(video.findMany.mock.lastCall?.[0].where).toMatchObject({
      projectId,
      project: { ownerId },
      OR: expect.any(Array),
    });
  });
  it('单个读取、保存和删除均包含项目路径与所有者，不能仅凭 Video ID 操作', async () => {
    const { service, video } = await setup();
    const where = { id, projectId, project: { ownerId } };
    await service.get(ownerId, projectId, id);
    expect(video.findFirst).toHaveBeenCalledWith({ where });
    expect(
      await service.save(ownerId, projectId, id, { revision: 1, name: '新名称', status: 'active' }),
    ).toMatchObject({ revision: 2 });
    expect(video.updateMany).toHaveBeenCalledWith({
      where: { ...where, revision: 1 },
      data: {
        name: '新名称',
        status: 'active',
        revision: { increment: 1 },
        updatedAt: expect.any(Date),
      },
    });
    await service.remove(ownerId, projectId, id);
    expect(video.deleteMany).toHaveBeenCalledWith({ where });
  });
  it('修订冲突不覆盖；不存在或跨项目的记录返回 404', async () => {
    const { service, video } = await setup();
    video.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.save(ownerId, projectId, id, { revision: 1, name: '修改', status: 'draft' }),
    ).rejects.toBeInstanceOf(ConflictException);
    video.findFirst.mockResolvedValue(null);
    video.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.get(ownerId, projectId, id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.save(ownerId, projectId, id, { revision: 1, name: '修改', status: 'draft' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(ownerId, projectId, id)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('非法 Project / Video / 请求在数据库调用前被拒绝', async () => {
    const { service, video, client, project } = await setup();
    for (const request of [
      () => service.list(ownerId, 'bad', {}),
      () => service.list(ownerId, projectId, { ownerId: 'other' }),
      () => service.create(ownerId, 'bad', { name: '作品' }),
      () => service.create(ownerId, projectId, { name: '作品', workflowId: id }),
      () => service.get(ownerId, projectId, 'bad'),
      () =>
        service.save(ownerId, projectId, id, { revision: 1, name: '作品', status: 'rendering' }),
      () => service.remove(ownerId, 'bad', id),
    ])
      await expect(request()).rejects.toBeInstanceOf(z.ZodError);
    expect(client.$transaction).not.toHaveBeenCalled();
    expect(project.findFirst).not.toHaveBeenCalled();
    expect(video.findFirst).not.toHaveBeenCalled();
    expect(video.updateMany).not.toHaveBeenCalled();
    expect(video.deleteMany).not.toHaveBeenCalled();
  });
});
