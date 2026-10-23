import 'reflect-metadata';
import type { NodeTypeManifest } from '@dramaflow/contracts';
import { NodeRegistry } from '@dramaflow/workflow';
import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AuthGuard } from '../../auth/auth.guard.js';
import { AuthService } from '../../auth/auth.service.js';
import { NodeTypesModule } from './node-types.module.js';

let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(registry?: NodeRegistry) {
  // 只替换会话读取，保留真实全局 AuthGuard 与控制器路由。
  const requireSession = vi.fn(async () => ({ user: { role: 'user' } }));
  const builder = Test.createTestingModule({
    imports: [NodeTypesModule],
    providers: [
      Reflector,
      { provide: AuthService, useValue: { requireSession } },
      {
        provide: APP_GUARD,
        useFactory: (auth: AuthService, reflector: Reflector) =>
          new AuthGuard(auth, reflector),
        inject: [AuthService, Reflector],
      },
    ],
  });
  if (registry) builder.overrideProvider(NodeRegistry).useValue(registry);
  const module = await builder.compile();
  app = module.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
  return {
    app,
    requireSession,
    registry: module.get<NodeRegistry>(NodeRegistry),
  };
}

describe('节点类型目录 API', () => {
  it('默认鉴权拒绝未登录请求，拒绝时不读取目录', async () => {
    const context = await setup();
    context.requireSession.mockRejectedValue(
      new UnauthorizedException('请先登录'),
    );
    const list = vi.spyOn(context.registry, 'listManifests');
    await request(context.app.getHttpServer())
      .get('/api/v1/workflow/node-types')
      .expect(401);
    expect(context.requireSession).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
  });

  it('受保护目录提供正式 AI / Control / Interaction 声明，禁止缓存', async () => {
    const context = await setup();
    const response = await request(context.app.getHttpServer())
      .get('/api/v1/workflow/node-types')
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(response.body).toMatchObject([
      { type: 'ai.text_generate', version: 1, executionKind: 'action' },
      {
        type: 'flow.if',
        version: 1,
        executionKind: 'control',
        outputs: [],
        controlOutputs: [{ key: 'true' }, { key: 'false' }],
      },
      {
        type: 'flow.human_review',
        version: 1,
        executionKind: 'interaction',
        inputs: [
          {
            key: 'content',
            required: true,
            dataType: { kind: 'primitive', name: 'string' },
          },
        ],
        outputs: [{ key: 'content' }, { key: 'action' }, { key: 'feedback' }],
        config: [{ key: 'instruction', required: false }],
      },
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(
      /apiKey|encryptedCredentials|configSchema|inputSchema|outputSchema/,
    );
    expect(context.registry.get('flow.human_review', 1)).not.toHaveProperty(
      'execute',
    );
    expect(() => context.registry.getAction('flow.human_review', 1)).toThrow(
      '不是普通',
    );
    expect(context.requireSession).toHaveBeenCalledOnce();
  });

  it('只传输显式注册类型的 Manifest，不公开 Zod、编译器或服务端数据', async () => {
    const manifest: NodeTypeManifest = {
      type: 'test.catalog',
      version: 1,
      executionKind: 'action',
      metadata: { name: '测试节点', category: 'data' },
      inputs: [],
      outputs: [],
      config: [],
    };
    const execute = vi.fn(async () => ({}));
    const nodeType = {
      manifest,
      configSchema: z.object({}),
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute,
      serverCredential: 'test-only-provider-key',
    };
    const registry = new NodeRegistry([nodeType]);
    const context = await setup(registry);
    const response = await request(context.app.getHttpServer())
      .get('/api/v1/workflow/node-types')
      .expect(200);
    expect(response.body).toEqual([manifest]);
    expect(JSON.stringify(response.body)).not.toMatch(
      /configSchema|inputSchema|outputSchema|execute|serverCredential|test-only-provider-key/,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('目录没有写入或执行接口', async () => {
    const context = await setup();
    await request(context.app.getHttpServer())
      .post('/api/v1/workflow/node-types')
      .send({})
      .expect(404);
    await request(context.app.getHttpServer())
      .post('/api/v1/workflow/node-types/test.catalog/execute')
      .send({})
      .expect(404);
  });
});
