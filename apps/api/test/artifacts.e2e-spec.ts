import 'reflect-metadata';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ImageType,
  JsonType,
  StringType,
  type RuntimeValue,
} from '@dramaflow/contracts';
import {
  ArtifactModule,
  ArtifactRepository,
  ArtifactRuntimeFactory,
  DatabaseService,
  NodeRunRepositories,
  StorageService,
  WorkflowCheckpointerService,
  WorkflowRunRepositories,
  WorkflowRuntimeFactory,
  WorkflowRuntimeInfrastructureModule,
} from '@dramaflow/server';
import { NodeRegistry } from '@dramaflow/workflow';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { WorkflowService } from '../src/workflow/workflows/workflow.service.js';
import {
  artifactDefinition,
  imageBytes,
  largeText,
  registerArtifactNodes,
} from './fixtures/artifact-workflow.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !==
    '/dramaflow_test'
)
  throw new Error('Artifact 集成测试仅允许独立测试数据库');
@Module({ imports: [WorkflowRuntimeInfrastructureModule, ArtifactModule] })
class ArtifactIntegrationModule {}
let app: INestApplicationContext;
let database: DatabaseService;
let storage: StorageService;
const ownerId = randomUUID();
const outsiderId = randomUUID();
const children = new Set<ChildProcess>();
beforeAll(async () => {
  app = await NestFactory.createApplicationContext(ArtifactIntegrationModule, {
    logger: false,
    abortOnError: false,
  });
  database = app.get(DatabaseService);
  storage = app.get(StorageService);
  await storage.ping();
  registerArtifactNodes(app.get(NodeRegistry));
  for (const id of [ownerId, outsiderId])
    await database.client.user.create({
      data: { id, name: '产物测试', email: `${id}@example.test` },
    });
});
afterAll(async () => {
  vi.restoreAllMocks();
  for (const child of children)
    if (child.exitCode === null) child.kill('SIGKILL');
  try {
    const db = database.client;
    const artifacts = await db.artifact.findMany({
      where: { project: { ownerId: { in: [ownerId, outsiderId] } } },
    });
    for (const artifact of artifacts) await storage.delete(artifact.storageKey);
    const runs = await db.workflowRun.findMany({
      where: { project: { ownerId: { in: [ownerId, outsiderId] } } },
    });
    for (const run of runs)
      await app
        .get(WorkflowCheckpointerService)
        .saver.deleteThread(run.threadId);
    await db.user.deleteMany({ where: { id: { in: [ownerId, outsiderId] } } });
  } finally {
    await app?.close();
  }
});

async function fixture(owner = ownerId) {
  const db = database.client;
  const project = await db.project.create({
    data: { ownerId: owner, name: '产物', viewport: {} },
  });
  const workflow = await db.workflow.create({
    data: {
      projectId: project.id,
      name: '产物',
      draft: z.record(z.string(), z.json()).parse(artifactDefinition()),
    },
  });
  const version = await new WorkflowService(database).publish(owner, {
    workflowId: workflow.id,
    expectedRevision: 1,
  });
  // 此处测试执行与内容边界，不交付 Queue Job；真实 Worker 子进程也不会被 Pump 重复触发。
  const run = await (
    await app.get(WorkflowRunRepositories).forProject(owner, project.id)
  ).create({
    projectId: project.id,
    workflowId: workflow.id,
    workflowVersionId: version.id,
    inputs: {},
  });
  return { ownerId: owner, projectId: project.id, run };
}
async function writingFixture() {
  const f = await fixture();
  await (
    await app.get(WorkflowRunRepositories).forProject(ownerId, f.projectId)
  ).markRunning(f.run.id);
  const node = await (
    await app.get(NodeRunRepositories).forRun(ownerId, f.projectId, f.run.id)
  ).createRunning({ workflowRunId: f.run.id, nodeId: 'A' });
  const codec = await app
    .get(ArtifactRuntimeFactory)
    .forRun(ownerId, f.projectId, f.run.id);
  const context = {
    projectId: f.projectId,
    workflowRunId: f.run.id,
    nodeRunId: node.id,
    nodeId: 'A',
    outputKey: 'payload',
  };
  const options = {
    type: JsonType,
    storagePolicy: 'reference' as const,
    context,
  };
  return { ...f, codec, context, options };
}
function artifactId(value: RuntimeValue) {
  if (value.storage !== 'reference' || value.reference.kind !== 'artifact')
    throw new Error('预期 ArtifactReference');
  return value.reference.id;
}
async function assertCheckpointsAreReferences(threadId: string) {
  let count = 0;
  for await (const tuple of app
    .get(WorkflowCheckpointerService)
    .saver.list({ configurable: { thread_id: threadId } })) {
    const serialized = JSON.stringify(tuple);
    expect(serialized).not.toContain('artifact-content-only-in-rustfs:');
    expect(serialized).not.toContain('X-Amz-Signature');
    expect(serialized).not.toContain('"bytes"');
    expect(serialized.length).toBeLessThan(30000);
    count++;
  }
  expect(count).toBeGreaterThan(1);
}

async function launch(command: {
  action: 'start' | 'resume';
  ownerId: string;
  projectId: string;
  runId: string;
}) {
  const child = fork(
    fileURLToPath(
      new URL('./fixtures/artifact-worker-process.ts', import.meta.url),
    ),
    [],
    {
      execArgv: ['--import', import.meta.resolve('tsx')],
      env: {
        ...process.env,
        WORKFLOW_QUEUE_PREFIX: `${process.env.WORKFLOW_QUEUE_PREFIX}-artifact-${command.runId}`,
      },
      silent: true,
    },
  );
  children.add(child);
  const eventSchema = z.discriminatedUnion('event', [
    z.object({ event: z.literal('ready') }),
    z.object({
      event: z.literal('result'),
      pid: z.number(),
      result: z
        .object({
          workflowRunId: z.string(),
          status: z.enum(['waiting', 'completed']),
        })
        .passthrough(),
    }),
    z.object({ event: z.literal('error'), message: z.string() }),
  ]);
  let response: z.infer<typeof eventSchema> | undefined;
  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-3000);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.on('message', (value) => {
      const event = eventSchema.parse(value);
      if (event.event === 'ready') child.send(command);
      else response = event;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`Artifact 子进程失败：${stderr}`));
    });
  });
  await exited;
  expect(response).toMatchObject({ event: 'result' });
  return response;
}

describe('生产 Artifact：PostgreSQL + RustFS + Runtime + persistent checkpoint', () => {
  it('生产 Compiler / Executor 的 A→B 管线读写真实 JSON 与二进制，State / NodeRun / Checkpoint 仅保存引用', async () => {
    const f = await fixture();
    const result = await (
      await app.get(WorkflowRuntimeFactory).forProject(ownerId, f.projectId)
    ).executeStart(f.run.id);
    expect(result).toMatchObject({
      status: 'completed',
      outputs: { length: { storage: 'inline', value: largeText.length } },
    });
    const db = database.client;
    const artifacts = await db.artifact.findMany({
      where: { workflowRunId: f.run.id },
    });
    expect(artifacts).toHaveLength(2);
    const nodes = await db.nodeRun.findMany({
      where: { workflowRunId: f.run.id },
      orderBy: { nodeId: 'asc' },
    });
    expect(nodes.map((node) => node.status)).toEqual([
      'completed',
      'completed',
    ]);
    for (const artifact of artifacts) {
      expect(artifact).toMatchObject({
        status: 'ready',
        nodeRunId: nodes[0]?.id,
        nodeId: 'A',
      });
      expect(artifact.storageKey).not.toContain('http');
      const bytes = await storage.get(artifact.storageKey);
      expect(bytes.byteLength).toBe(artifact.size);
      if (artifact.contentKind === 'json')
        expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
          text: largeText,
        });
      else expect(bytes).toEqual(imageBytes);
    }
    expect(nodes[1]?.inputs).toEqual(nodes[0]?.outputs);
    const history = JSON.stringify(nodes);
    expect(history).not.toContain('artifact-content-only-in-rustfs:');
    expect(history).not.toContain('X-Amz-Signature');
    const tuple = await app
      .get(WorkflowCheckpointerService)
      .saver.getTuple({ configurable: { thread_id: f.run.threadId } });
    expect(tuple?.checkpoint.channel_values.outputs).toMatchObject({
      A: nodes[0]?.outputs,
      B: nodes[1]?.outputs,
    });
    await assertCheckpointsAreReferences(f.run.threadId);
  });

  it('进程 A 写完产物并退出；全新进程 B 从原 checkpoint 恢复后解析 Artifact，A 不重复执行', async () => {
    const f = await fixture();
    const command = { ownerId, projectId: f.projectId, runId: f.run.id };
    const first = await launch({ action: 'start', ...command });
    expect(first).toMatchObject({ result: { status: 'waiting' } });
    expect(
      await database.client.nodeRun.count({
        where: { workflowRunId: f.run.id, nodeId: 'B' },
      }),
    ).toBe(0);
    await assertCheckpointsAreReferences(f.run.threadId);
    const second = await launch({ action: 'resume', ...command });
    expect(second).toMatchObject({ result: { status: 'completed' } });
    if (first?.event !== 'result' || second?.event !== 'result')
      throw new Error('缺少测试结果');
    expect(first.pid).not.toBe(second.pid);
    const nodes = await database.client.nodeRun.findMany({
      where: { workflowRunId: f.run.id },
      orderBy: { nodeId: 'asc' },
    });
    expect(
      nodes.map((node) => [node.nodeId, node.attempt, node.status]),
    ).toEqual([
      ['A', 1, 'completed'],
      ['B', 1, 'completed'],
    ]);
    expect(nodes[1]?.inputs).toEqual(nodes[0]?.outputs);
    expect(
      await database.client.artifact.count({
        where: { workflowRunId: f.run.id, status: 'ready' },
      }),
    ).toBe(2);
    await assertCheckpointsAreReferences(f.run.threadId);
  });

  it('同一项目允许另一个已授权 Run 解析；跨项目、伪造上下文或其他所有者不能读取，拒绝前不访问 RustFS', async () => {
    const f = await writingFixture();
    const value = await f.codec.encode({ secret: 'project-a' }, f.options);
    const sameProjectRun = await (
      await app.get(WorkflowRunRepositories).forProject(ownerId, f.projectId)
    ).create({
      projectId: f.projectId,
      workflowId: f.run.workflowId,
      workflowVersionId: f.run.workflowVersionId,
      inputs: {},
    });
    const same = await app
      .get(ArtifactRuntimeFactory)
      .forRun(ownerId, f.projectId, sameProjectRun.id);
    expect(
      await same.decode(value, {
        projectId: f.projectId,
        workflowRunId: sameProjectRun.id,
      }),
    ).toEqual({ secret: 'project-a' });
    const other = await fixture(outsiderId);
    const codec = await app
      .get(ArtifactRuntimeFactory)
      .forRun(outsiderId, other.projectId, other.run.id);
    const sameOwnerOtherProject = await fixture();
    const sameOwnerCodec = await app
      .get(ArtifactRuntimeFactory)
      .forRun(
        ownerId,
        sameOwnerOtherProject.projectId,
        sameOwnerOtherProject.run.id,
      );
    const get = vi.spyOn(storage, 'get');
    const head = vi.spyOn(storage, 'head');
    try {
      for (const context of [
        { projectId: other.projectId, workflowRunId: other.run.id },
        f.context,
      ])
        await expect(codec.decode(value, context)).rejects.toMatchObject({
          code: 'REFERENCE_RESOLUTION_FAILED',
        });
      await expect(
        sameOwnerCodec.decode(value, {
          projectId: sameOwnerOtherProject.projectId,
          workflowRunId: sameOwnerOtherProject.run.id,
        }),
      ).rejects.toMatchObject({ code: 'REFERENCE_RESOLUTION_FAILED' });
      await expect(
        app
          .get(ArtifactRuntimeFactory)
          .forRun(outsiderId, f.projectId, f.run.id),
      ).rejects.toThrow();
      expect(get).not.toHaveBeenCalled();
      expect(head).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      head.mockRestore();
    }
  });

  it('写入拒绝项目 / NodeRun 来源拼接，数据库复合外键继续保护同项目同运行来源', async () => {
    const f = await writingFixture();
    const other = await writingFixture();
    const put = vi.spyOn(storage, 'put');
    try {
      for (const context of [
        { ...f.context, projectId: other.projectId },
        { ...f.context, nodeRunId: other.context.nodeRunId },
        { ...f.context, nodeId: 'wrong-node' },
      ])
        await expect(
          f.codec.encode({}, { ...f.options, context }),
        ).rejects.toMatchObject({
          code: 'ARTIFACT_WRITE_FAILED',
          stage: 'register',
        });
      expect(put).not.toHaveBeenCalled();
      expect(
        await database.client.artifact.count({
          where: { workflowRunId: f.run.id },
        }),
      ).toBe(0);
    } finally {
      put.mockRestore();
    }
    const value = await f.codec.encode({}, f.options);
    const record = await database.client.artifact.findUniqueOrThrow({
      where: { id: artifactId(value) },
    });
    await expect(
      database.client.artifact.create({
        data: {
          ...record,
          id: randomUUID(),
          storageKey: `invalid/${randomUUID()}`,
          nodeRunId: other.context.nodeRunId,
          type: z.record(z.string(), z.json()).parse(record.type),
        },
      }),
    ).rejects.toThrow();
  });

  it('不存在 / 已删除对象及内容损坏在 Reference 解析边界明确失败，媒体不能只签 URL 就成功', async () => {
    const f = await writingFixture();
    for (const options of [f.options, { ...f.options, type: ImageType }]) {
      const value = await f.codec.encode(
        options.type === ImageType
          ? { bytes: imageBytes, mimeType: 'image/png' }
          : { text: largeText },
        options,
      );
      const row = await database.client.artifact.findUniqueOrThrow({
        where: { id: artifactId(value) },
      });
      await storage.delete(row.storageKey);
      await expect(f.codec.decode(value, f.context)).rejects.toMatchObject({
        code: 'REFERENCE_RESOLUTION_FAILED',
      });
    }
    const missing: RuntimeValue = {
      storage: 'reference',
      type: JsonType,
      reference: { kind: 'artifact', id: randomUUID() },
    };
    await expect(f.codec.decode(missing, f.context)).rejects.toMatchObject({
      code: 'REFERENCE_RESOLUTION_FAILED',
    });
    const value = await f.codec.encode('original', {
      ...f.options,
      type: StringType,
    });
    const row = await database.client.artifact.findUniqueOrThrow({
      where: { id: artifactId(value) },
    });
    expect(await f.codec.decode(value, f.context)).toBe('original');
    await storage.put(
      row.storageKey,
      new TextEncoder().encode('"tampered"'),
      'application/json',
    );
    await expect(f.codec.decode(value, f.context)).rejects.toMatchObject({
      code: 'REFERENCE_RESOLUTION_FAILED',
    });
  });

  it('数据库登记失败不上传对象；PUT 已写入后报错会删除对象并留下 failed 记录', async () => {
    const f = await writingFixture();
    const repository = app.get(ArtifactRepository);
    const register = vi
      .spyOn(repository, 'createWriting')
      .mockRejectedValueOnce(new Error('DB unavailable'));
    const put = vi.spyOn(storage, 'put');
    try {
      await expect(f.codec.encode({}, f.options)).rejects.toMatchObject({
        code: 'ARTIFACT_WRITE_FAILED',
        stage: 'register',
      });
      expect(put).not.toHaveBeenCalled();
      expect(
        await database.client.artifact.count({
          where: { workflowRunId: f.run.id },
        }),
      ).toBe(0);
    } finally {
      register.mockRestore();
      put.mockRestore();
    }
    const upload = storage.put.bind(storage);
    const failAfterUpload = vi
      .spyOn(storage, 'put')
      .mockImplementationOnce(async (...args) => {
        await upload(...args);
        throw new Error('PUT acknowledgement lost');
      });
    try {
      await expect(f.codec.encode({}, f.options)).rejects.toMatchObject({
        code: 'ARTIFACT_WRITE_FAILED',
        stage: 'upload',
      });
    } finally {
      failAfterUpload.mockRestore();
    }
    const row = await database.client.artifact.findFirstOrThrow({
      where: { workflowRunId: f.run.id },
    });
    expect(row).toMatchObject({
      status: 'failed',
      failureStage: 'upload',
      cleanupRequired: false,
    });
    await expect(storage.get(row.storageKey)).rejects.toThrow();
    await expect(
      f.codec.decode(
        {
          storage: 'reference',
          type: JsonType,
          reference: { kind: 'artifact', id: row.id },
        },
        f.context,
      ),
    ).rejects.toMatchObject({ code: 'REFERENCE_RESOLUTION_FAILED' });
  });

  it('上传补偿也失败时保留 cleanupRequired；失败记录不可写时原始上传原因仍在 AggregateError 中', async () => {
    const f = await writingFixture();
    const uploadError = new Error('upload failure');
    const upload = storage.put.bind(storage);
    const put = vi
      .spyOn(storage, 'put')
      .mockImplementationOnce(async (...args) => {
        await upload(...args);
        throw uploadError;
      });
    const cleanup = vi
      .spyOn(storage, 'delete')
      .mockRejectedValueOnce(new Error('cleanup unavailable'));
    try {
      await expect(f.codec.encode({}, f.options)).rejects.toMatchObject({
        stage: 'upload',
        cause: { errors: [uploadError, expect.any(Error)] },
      });
    } finally {
      put.mockRestore();
      cleanup.mockRestore();
    }
    const row = await database.client.artifact.findFirstOrThrow({
      where: { workflowRunId: f.run.id },
    });
    expect(row).toMatchObject({ status: 'failed', cleanupRequired: true });
    const put2 = vi.spyOn(storage, 'put').mockRejectedValueOnce(uploadError);
    const mark = vi
      .spyOn(app.get(ArtifactRepository), 'markFailed')
      .mockRejectedValueOnce(new Error('DB unavailable'));
    try {
      await expect(f.codec.encode({}, f.options)).rejects.toMatchObject({
        cause: { errors: [uploadError, expect.any(Error)] },
      });
    } finally {
      put2.mockRestore();
      mark.mockRestore();
    }
    expect(
      await database.client.artifact.count({
        where: { workflowRunId: f.run.id, status: 'writing' },
      }),
    ).toBe(1);
  });

  it('上传后 DB 确认失败只保留 writing；确认已提交但响应丢失时保留真实 ready 内容，均不返回成功引用', async () => {
    const f = await writingFixture();
    const repository = app.get(ArtifactRepository);
    const ready = repository.markReady.bind(repository);
    const failure = vi
      .spyOn(repository, 'markReady')
      .mockRejectedValueOnce(new Error('DB unavailable'));
    try {
      await expect(
        f.codec.encode({ text: 'stored' }, f.options),
      ).rejects.toMatchObject({
        code: 'ARTIFACT_WRITE_FAILED',
        stage: 'finalize',
      });
    } finally {
      failure.mockRestore();
    }
    const row = await database.client.artifact.findFirstOrThrow({
      where: { workflowRunId: f.run.id },
    });
    expect(row.status).toBe('writing');
    expect(await storage.get(row.storageKey)).not.toHaveLength(0);
    await expect(
      f.codec.decode(
        {
          storage: 'reference',
          type: JsonType,
          reference: { kind: 'artifact', id: row.id },
        },
        f.context,
      ),
    ).rejects.toMatchObject({ code: 'REFERENCE_RESOLUTION_FAILED' });
    const ambiguous = vi
      .spyOn(repository, 'markReady')
      .mockImplementationOnce(async (...args) => {
        await ready(...args);
        throw new Error('commit acknowledgement lost');
      });
    try {
      await expect(
        f.codec.encode({ text: 'committed' }, f.options),
      ).rejects.toMatchObject({ stage: 'finalize' });
    } finally {
      ambiguous.mockRestore();
    }
    const committed = await database.client.artifact.findFirstOrThrow({
      where: { workflowRunId: f.run.id, status: 'ready' },
    });
    expect(
      await f.codec.decode(
        {
          storage: 'reference',
          type: JsonType,
          reference: { kind: 'artifact', id: committed.id },
        },
        f.context,
      ),
    ).toEqual({ text: 'committed' });
    await expect(
      database.client.artifact.update({
        where: { id: committed.id },
        data: { storageKey: 'changed' },
      }),
    ).rejects.toThrow();
    await expect(
      database.client.artifact.update({
        where: { id: committed.id },
        data: { status: 'failed', failureStage: 'upload' },
      }),
    ).rejects.toThrow();
  });
});
