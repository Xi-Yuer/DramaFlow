import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { z } from 'zod';
import {
  WorkflowRunCancellationService,
  WorkflowRunQueryService,
  type DatabaseService,
  type WorkflowRunRepositories,
} from '@dramaflow/server';
import { AuthGuard } from '../../auth/auth.guard.js';
import { AuthService } from '../../auth/auth.service.js';
import { authBaseUrl } from '../../auth/trusted-origin.js';
import { ApiExceptionFilter } from '../../http/exception.filter.js';
import { WorkflowRunCancellationController } from './workflow-run-cancellation.controller.js';

const project = '00000000-0000-4000-8000-000000000001';
const otherProject = '00000000-0000-4000-8000-000000000002';
let app: INestApplication;
afterEach(async () => {
  await app?.close();
});
async function setup(status = 'running') {
  const row = {
    id: 'run',
    projectId: project,
    workflowId: 'workflow',
    workflowVersionId: 'version',
    invocationKey: 'key',
    threadId: 'private-thread',
    status,
    inputs: {},
    outputs: null as object | null,
    error: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null as Date | null,
    cancellationRequestedAt: null as Date | null,
    waitingRevision: 0,
    executions: [
      { kind: 'start', waitingRevision: 0, status: 'executing', id: 'internal-execution' },
    ],
  };
  const session = vi.fn().mockResolvedValue({ user: { id: 'owner', role: 'user' } });
  const parseWhere = (input: unknown) =>
    z
      .object({
        where: z.object({
          id: z.string(),
          workflowId: z.string().optional(),
          projectId: z.string().optional(),
          project: z.object({ ownerId: z.string() }),
        }),
      })
      .parse(input).where;
  const workflow = vi.fn(async (input: unknown) => {
    const where = parseWhere(input);
    return where.id === row.workflowId &&
      where.projectId === project &&
      where.project.ownerId === 'owner'
      ? { id: row.workflowId }
      : null;
  });
  const run = vi.fn(async (input: unknown) => {
    const where = parseWhere(input);
    return where.id === row.id &&
      (!where.projectId || where.projectId === project) &&
      (!where.workflowId || where.workflowId === row.workflowId) &&
      where.project.ownerId === 'owner'
      ? row
      : null;
  });
  const database = {
    client: { workflow: { findFirst: workflow }, workflowRun: { findFirst: run } },
  } as unknown as DatabaseService;
  const cancellation = vi.fn(async () => {
    if (['completed', 'failed', 'cancelled'].includes(row.status)) return;
    row.cancellationRequestedAt ??= new Date();
    if (row.status !== 'running') {
      row.status = 'cancelled';
      row.completedAt = new Date();
    }
  });
  const repositories = {
    forProject: vi.fn(async () => ({ requestCancellation: cancellation })),
  } as unknown as WorkflowRunRepositories;
  const service = new WorkflowRunCancellationService(
    database,
    repositories,
    new WorkflowRunQueryService(database),
  );
  const module = await Test.createTestingModule({
    controllers: [WorkflowRunCancellationController],
    providers: [
      { provide: WorkflowRunCancellationService, useValue: service },
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
  const post = (projectId = project, workflowId = 'workflow', runId = 'run', body: object = {}) =>
    request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/workflows/${workflowId}/runs/${runId}/cancel`)
      .set('Origin', new URL(authBaseUrl()).origin)
      .send(body);
  return { row, session, cancellation, repositories, post, workflow, run };
}
describe('正式 Cancel HTTP / scope 与安全 DTO', () => {
  it('取消写请求继续要求可信 Origin', async () => {
    const f = await setup();
    const path = `/api/v1/projects/${project}/workflows/workflow/runs/run/cancel`;
    await request(app.getHttpServer()).post(path).send({}).expect(403);
    await request(app.getHttpServer())
      .post(path)
      .set('Origin', 'https://untrusted.example')
      .send({})
      .expect(403);
    expect(f.cancellation).not.toHaveBeenCalled();
  });
  it.each(['pending', 'waiting'])(
    '%s 取消及重复取消返回 cancelled，保留首次请求事实',
    async (status) => {
      const f = await setup(status);
      const first = await f.post().expect(200).expect('Cache-Control', 'no-store');
      expect(first.body).toMatchObject({
        outcome: 'cancelled',
        run: { status: 'cancelled', cancellation: 'none' },
      });
      expect((await f.post().expect(200)).body).toEqual(first.body);
    },
  );
  it('running 只返回 requested，重复请求幂等，无内部 execution 信息', async () => {
    const f = await setup();
    const first = await f.post().expect(200);
    expect(first.body).toMatchObject({
      outcome: 'requested',
      run: { status: 'running', cancellation: 'requested' },
    });
    expect((await f.post().expect(200)).body).toEqual(first.body);
    for (const internal of [
      'threadId',
      'Outbox',
      'executions',
      'executionId',
      'lock',
      'checkpoint',
      'private-thread',
      'internal-execution',
    ])
      expect(JSON.stringify(first.body)).not.toContain(internal);
  });
  it.each(['completed', 'failed'])(
    '取消与 %s 竞争：读取最新真实终态，不报告 cancelled',
    async (status) => {
      const f = await setup();
      f.cancellation.mockImplementationOnce(async () => {
        f.row.status = status;
      });
      const response = await f.post().expect(200);
      expect(response.body).toMatchObject({
        outcome: 'terminal',
        run: { status, cancellation: 'none' },
      });
      expect(f.row.cancellationRequestedAt).toBeNull();
    },
  );
  it.each(['completed', 'failed', 'cancelled'])('已经 %s 的重复操作保留终态', async (status) => {
    const f = await setup(status);
    expect((await f.post().expect(200)).body).toMatchObject({
      outcome: status === 'cancelled' ? 'cancelled' : 'terminal',
      run: { status },
    });
  });
  it('uncertain 保留 requested outcome 与读模型，不假装已停止', async () => {
    const f = await setup();
    f.row.cancellationRequestedAt = new Date();
    f.row.executions[0]!.status = 'recovery_required';
    expect((await f.post().expect(200)).body).toMatchObject({
      outcome: 'requested',
      run: { status: 'running', cancellation: 'uncertain' },
    });
  });
  it('未登录 / 他人 / 错 Project、Workflow、Run 均不得发出取消请求', async () => {
    const f = await setup();
    f.session.mockRejectedValueOnce(new UnauthorizedException());
    await f.post().expect(401);
    f.session.mockResolvedValueOnce({ user: { id: 'outsider', role: 'user' } });
    await f.post().expect(404);
    await f.post(otherProject).expect(404);
    await f.post(project, 'other-workflow').expect(404);
    await f.post(project, 'workflow', 'other-run').expect(404);
    expect(f.cancellation).not.toHaveBeenCalled();
  });
  it('body 不允许覆盖 owner、status 或执行身份', async () => {
    const f = await setup();
    for (const key of ['ownerId', 'status', 'threadId', 'executionId'])
      await f.post(project, 'workflow', 'run', { [key]: 'injected' }).expect(400);
    expect(f.cancellation).not.toHaveBeenCalled();
  });
});
