import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WorkflowRunQueryService, type DatabaseService } from '@dramaflow/server';
import { AuthGuard } from '../../auth/auth.guard.js';
import { AuthService } from '../../auth/auth.service.js';
import { ApiExceptionFilter } from '../../http/exception.filter.js';
import { WorkflowRunHistoryController } from './workflow-runs.controller.js';
import { WorkflowRuntimeService } from './workflow-runtime.service.js';
let app: INestApplication;
afterEach(async () => {
  await app?.close();
});
const projectId = '00000000-0000-4000-8000-000000000001';
async function setup() {
  const session = vi.fn().mockResolvedValue({ user: { id: 'owner', role: 'user' } });
  const row = {
    id: 'run',
    workflowId: 'workflow',
    workflowVersionId: 'version',
    status: 'completed',
    createdAt: new Date('2026-10-28T00:00:00.000Z'),
    startedAt: null,
    completedAt: null,
    error: null,
    threadId: 'never-public',
  };
  const workflow = { findFirst: vi.fn().mockResolvedValue({ id: 'workflow' }) };
  const client = {
    workflow,
    workflowRun: { findMany: vi.fn().mockResolvedValue([row]) },
    workflowVersion: { findMany: vi.fn().mockResolvedValue([{ id: 'version', version: 1 }]) },
  };
  const query = new WorkflowRunQueryService({ client } as unknown as DatabaseService);
  const module = await Test.createTestingModule({
    controllers: [WorkflowRunHistoryController],
    providers: [
      { provide: WorkflowRuntimeService, useValue: { listRuns: query.listRuns.bind(query) } },
      { provide: AuthService, useValue: { requireSession: session } },
      Reflector,
      {
        provide: APP_GUARD,
        useFactory: (auth: AuthService, reflector: Reflector) => new AuthGuard(auth, reflector),
        inject: [AuthService, Reflector],
      },
    ],
  }).compile();
  app = module.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.init();
  return { session, client };
}
describe('正式 Run History HTTP 查询入口', () => {
  it('鉴权、no-store 与公开 DTO；query 不能注入 owner / 内部字段', async () => {
    const f = await setup();
    const response = await request(app.getHttpServer())
      .get(`/api/v1/projects/${projectId}/workflows/workflow/runs`)
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(response.body.items[0]).toEqual({
      id: 'run',
      workflowId: 'workflow',
      workflowVersionId: 'version',
      version: 1,
      status: 'completed',
      cancellation: 'none',
      createdAt: '2026-10-28T00:00:00.000Z',
    });
    expect(JSON.stringify(response.body)).not.toContain('thread');
    expect(f.client.workflow.findFirst).toHaveBeenCalledWith({
      where: { id: 'workflow', projectId, project: { ownerId: 'owner' } },
      select: { id: true },
    });
    await request(app.getHttpServer())
      .get(`/api/v1/projects/${projectId}/workflows/workflow/runs?ownerId=other`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/api/v1/projects/${projectId}/workflows/workflow/runs?cursor=A`)
      .expect(400);
  });
  it('未登录 401，无权限 404，均不返回其他工作流运行', async () => {
    const f = await setup();
    f.session.mockRejectedValueOnce(new UnauthorizedException());
    await request(app.getHttpServer())
      .get(`/api/v1/projects/${projectId}/workflows/workflow/runs`)
      .expect(401);
    expect(f.client.workflowRun.findMany).not.toHaveBeenCalled();
    f.client.workflow.findFirst.mockResolvedValueOnce(null);
    await request(app.getHttpServer())
      .get(`/api/v1/projects/${projectId}/workflows/workflow/runs`)
      .expect(404);
    expect(f.client.workflowRun.findMany).not.toHaveBeenCalled();
  });
});
