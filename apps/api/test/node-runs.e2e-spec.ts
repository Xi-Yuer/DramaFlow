import { randomUUID } from 'node:crypto';
import { END, START, StateGraph } from '@langchain/langgraph';
import {
  ImageType,
  StringType,
  VideoType,
  type NodeDefinition,
  type NodeTypeManifest,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import {
  DatabaseService,
  NodeRunRepositories,
  WorkflowRunRepositories,
} from '@dramaflow/server';
import {
  ActionNodeCompilationStrategy,
  createBindingResolver,
  DefaultDataStoragePolicyResolver,
  DefaultNodeExecutor,
  DefaultRuntimeValueCodec,
  NodeRegistry,
  WorkflowStateAnnotation,
  type ArtifactWriter,
  type DataReferenceResolver,
  type LangGraphNode,
  type WorkflowState,
} from '@dramaflow/workflow';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !==
    '/dramaflow_test'
)
  throw new Error('NodeRun 集成测试仅允许在 DramaFlow 的隔离测试数据库运行');

const database = new DatabaseService();
const db = database.client;
const repositories = new NodeRunRepositories(database);
const workflowRuns = new WorkflowRunRepositories(database);
const ownerId = randomUUID();
const otherId = randomUUID();
let projectId: string;
let otherProjectId: string;

beforeAll(async () => {
  for (const id of [ownerId, otherId])
    await db.user.create({
      data: { id, name: '节点执行测试', email: `${id}@example.test` },
    });
  projectId = (
    await db.project.create({
      data: {
        ownerId,
        name: '节点执行测试',
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    })
  ).id;
  otherProjectId = (
    await db.project.create({
      data: {
        ownerId: otherId,
        name: '隔离项目',
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    })
  ).id;
});
afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
  await database.onModuleDestroy();
});

async function createParentRun(
  owner = ownerId,
  project = projectId,
): Promise<string> {
  const repository = await workflowRuns.forProject(owner, project);
  const run = await repository.create({
    projectId: project,
    workflowId: 'workflow',
    workflowVersionId: 'version',
    inputs: {},
  });
  await repository.markRunning(run.id);
  return run.id;
}

async function videoFixture() {
  const workflowRunId = await createParentRun();
  const repository = await repositories.forRun(
    ownerId,
    projectId,
    workflowRunId,
  );
  const node: NodeDefinition = {
    id: 'video_1',
    type: 'video.image_to_video',
    typeVersion: 1,
    name: '图生视频',
    inputs: {
      image: { type: 'asset', assetId: 'image', versionId: 'v3' },
      prompt: { type: 'constant', value: '人物向前走' },
    },
    config: {},
    ui: { position: { x: 0, y: 0 } },
  };
  const manifest: NodeTypeManifest = {
    type: node.type,
    version: 1,
    executionKind: 'action',
    metadata: { name: node.name, category: 'video' },
    inputs: [
      { key: 'image', name: '图片', dataType: ImageType },
      { key: 'prompt', name: '提示词', dataType: StringType },
    ],
    outputs: [{ key: 'video', name: '视频', dataType: VideoType }],
    config: [],
  };
  const resourceSchema = z.object({
    id: z.string(),
    mediaType: z.string(),
    access: z.object({ url: z.string() }),
  });
  const video = {
    id: 'business-video',
    mediaType: 'video',
    access: { url: 'https://test.invalid/decoded-business-video' },
  };
  const execute = vi.fn(async () => ({ video }));
  const registry = new NodeRegistry([
    {
      manifest,
      inputSchema: z.object({ image: resourceSchema, prompt: z.string() }),
      outputSchema: z.object({ video: resourceSchema }),
      configSchema: z.object({}).strict(),
      execute,
    },
  ]);
  // 真实节点记录落 PostgreSQL；内容服务仍明确使用测试替身，不声称已创建真实视频或 Artifact。
  const write = vi
    .fn<ArtifactWriter['write']>()
    .mockResolvedValue({ kind: 'artifact', id: 'test-video-artifact' });
  const resolve = vi.fn<DataReferenceResolver['resolve']>().mockResolvedValue({
    id: 'image',
    mediaType: 'image',
    access: { url: 'https://test.invalid/decoded-business-image' },
  });
  const executor = new DefaultNodeExecutor(
    registry,
    createBindingResolver(),
    new DefaultRuntimeValueCodec(
      { resolve },
      { write },
      new DefaultDataStoragePolicyResolver(),
    ),
    repository,
  );
  const workflow: WorkflowDefinition = {
    inputs: [],
    nodes: [node],
    edges: [],
    outputs: [],
  };
  const initial: WorkflowState = {
    run: {
      projectId,
      workflowRunId,
      workflowId: 'workflow',
      workflowVersionId: 'version',
    },
    inputs: {},
    outputs: {},
    variables: {},
    execution: {},
  };
  let wrapper: LangGraphNode | undefined;
  new ActionNodeCompilationStrategy().compile({
    node,
    manifest,
    executor,
    executionContext: (config) => ({ workflow, runnableConfig: config }),
    addNode: (_id, action) => {
      wrapper = action;
    },
  });
  if (!wrapper) throw new Error('测试节点未被编译');
  const graph = new StateGraph(WorkflowStateAnnotation)
    .addNode(node.id, wrapper)
    .addEdge(START, node.id)
    .addEdge(node.id, END)
    .compile();
  return {
    workflowRunId,
    repository,
    executor,
    node,
    workflow,
    initial,
    execute,
    graph,
  };
}

describe('真实 PostgreSQL NodeRun', () => {
  it('业务已成功但完成记录不可用时保留 running，不反向记录为 failed 或写入 State', async () => {
    const f = await videoFixture();
    const failure = new Error('完成记录服务不可用');
    vi.spyOn(f.repository, 'markCompleted').mockRejectedValue(failure);
    const markFailed = vi.spyOn(f.repository, 'markFailed');
    await expect(f.graph.invoke(f.initial)).rejects.toBe(failure);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(markFailed).not.toHaveBeenCalled();
    const rows = await db.nodeRun.findMany({
      where: { workflowRunId: f.workflowRunId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'running',
      inputs: expect.any(Object),
      outputs: null,
      error: null,
      completedAt: null,
    });
    expect(f.initial.outputs).toEqual({});
  });

  it('最小创建参数连续分配 attempt 1/2，并持久化完成与失败两条记录', async () => {
    const workflowRunId = await createParentRun();
    const repository = await repositories.forRun(
      ownerId,
      projectId,
      workflowRunId,
    );
    const first = await repository.createRunning({
      workflowRunId,
      nodeId: 'image-1',
    });
    const second = await repository.createRunning({
      workflowRunId,
      nodeId: 'image-1',
    });
    expect([first.attempt, second.attempt]).toEqual([1, 2]);
    expect(first.id).not.toBe(second.id);
    expect(first.status).toBe('running');
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(first.startedAt).toEqual(expect.any(String));
    const inputs = {
      prompt: { storage: 'inline', type: StringType, value: '生成图片' },
    } as const;
    const outputs = {
      image: {
        storage: 'reference',
        type: ImageType,
        reference: { kind: 'artifact', id: 'image-artifact' },
      },
    } as const;
    await repository.updateInputs(first.id, inputs);
    await repository.markCompleted(first.id, outputs);
    const error = { stage: 'provider_request', message: '请求失败' };
    await repository.markFailed(second.id, error);
    const rows = await db.nodeRun.findMany({
      where: { workflowRunId },
      orderBy: { attempt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: first.id,
      status: 'completed',
      inputs,
      outputs,
      error: null,
      completedAt: expect.any(Date),
    });
    expect(rows[1]).toMatchObject({
      id: second.id,
      status: 'failed',
      inputs: null,
      outputs: null,
      error,
      completedAt: expect.any(Date),
    });
  });

  it('第一次业务失败、第二次成功形成两条历史，State 仅包含成功输出引用', async () => {
    const f = await videoFixture();
    f.execute.mockRejectedValueOnce(
      new Error('provider-credential-test-marker'),
    );
    await expect(f.graph.invoke(f.initial)).rejects.toMatchObject({
      stage: 'execute',
    });
    expect(f.initial.outputs).toEqual({});
    const state = await f.graph.invoke(f.initial);
    const rows = await db.nodeRun.findMany({
      where: { workflowRunId: f.workflowRunId },
      orderBy: { attempt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      nodeId: 'video_1',
      attempt: 1,
      status: 'failed',
      outputs: null,
      error: { stage: 'execute' },
    });
    expect(rows[1]).toMatchObject({
      nodeId: 'video_1',
      attempt: 2,
      status: 'completed',
      error: null,
    });
    for (const row of rows) {
      expect(row.inputs).toEqual({
        image: {
          storage: 'reference',
          type: ImageType,
          reference: { kind: 'asset', id: 'image', versionId: 'v3' },
        },
        prompt: { storage: 'inline', type: StringType, value: '人物向前走' },
      });
      expect(row.completedAt).toBeInstanceOf(Date);
      expect(row.completedAt!.getTime()).toBeGreaterThanOrEqual(
        row.startedAt.getTime(),
      );
    }
    expect(rows[1]!.outputs).toEqual({
      video: {
        storage: 'reference',
        type: VideoType,
        reference: { kind: 'artifact', id: 'test-video-artifact' },
      },
    });
    expect(state.outputs).toEqual({ video_1: rows[1]!.outputs });
    expect(JSON.stringify(rows)).not.toContain('decoded-business');
    expect(JSON.stringify(rows)).not.toContain(
      'provider-credential-test-marker',
    );
  });

  it('Binding 失败也有 failed 记录，inputs 保持未解析，业务未执行', async () => {
    const f = await videoFixture();
    const node = {
      ...f.node,
      inputs: {
        ...f.node.inputs,
        prompt: { type: 'workflow_input', key: 'missing' } as const,
      },
    };
    await expect(
      f.executor.execute(node, {
        workflow: f.workflow,
        state: f.initial,
        projectId,
        workflowRunId: f.workflowRunId,
      }),
    ).rejects.toMatchObject({ stage: 'resolve_input' });
    const rows = await db.nodeRun.findMany({
      where: { workflowRunId: f.workflowRunId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'failed',
      inputs: null,
      outputs: null,
      error: { stage: 'resolve_input' },
    });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('多个 Repository 实例并发创建时原子分配连续 attempt，数据库约束拒绝重复', async () => {
    const workflowRunId = await createParentRun();
    const first = await repositories.forRun(ownerId, projectId, workflowRunId);
    const second = await repositories.forRun(ownerId, projectId, workflowRunId);
    const input = { workflowRunId, nodeId: 'concurrent' };
    const runs = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? first : second).createRunning(input),
      ),
    );
    expect(runs.map((run) => run.attempt).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(new Set(runs.map((run) => run.id)).size).toBe(12);
    expect(
      (await first.createRunning({ ...input, nodeId: 'different' })).attempt,
    ).toBe(1);
    await expect(
      db.nodeRun.create({
        data: { projectId, workflowRunId, nodeId: 'concurrent', attempt: 1 },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('inputs 只记录一次，completed / failed 历史不被改写', async () => {
    const workflowRunId = await createParentRun();
    const repo = await repositories.forRun(ownerId, projectId, workflowRunId);
    const run = await repo.createRunning({
      workflowRunId,
      nodeId: 'terminal',
    });
    await repo.updateInputs(run.id, {});
    await expect(repo.updateInputs(run.id, {})).rejects.toThrow();
    await repo.markCompleted(run.id, {});
    const before = await db.nodeRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    await expect(
      repo.markFailed(run.id, {
        code: 'late',
        message: '迟到失败',
        stage: 'execute',
      }),
    ).rejects.toThrow();
    await expect(repo.markCompleted(run.id, {})).rejects.toThrow();
    expect(
      await db.nodeRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toEqual(before);
    const failed = await repo.createRunning({
      workflowRunId,
      nodeId: 'terminal',
    });
    await repo.markFailed(failed.id, {
      message: '执行失败',
      stage: 'provider_request',
    });
    const failedSnapshot = await db.nodeRun.findUniqueOrThrow({
      where: { id: failed.id },
    });
    expect(failedSnapshot.error).toEqual({
      stage: 'provider_request',
      message: '执行失败',
    });
    await expect(repo.markCompleted(failed.id, {})).rejects.toThrow();
    await expect(repo.updateInputs(failed.id, {})).rejects.toThrow();
    expect(
      await db.nodeRun.findUniqueOrThrow({ where: { id: failed.id } }),
    ).toEqual(failedSnapshot);
  });

  it('限定所有者、项目与运行，不能凭 NodeRun ID 写其他范围的历史', async () => {
    const workflowRunId = await createParentRun();
    await expect(
      repositories.forRun(otherId, projectId, workflowRunId),
    ).rejects.toThrow('无权访问');
    const first = await repositories.forRun(ownerId, projectId, workflowRunId);
    const otherProject = await repositories.forRun(
      otherId,
      otherProjectId,
      await createParentRun(otherId, otherProjectId),
    );
    const otherRun = await repositories.forRun(
      ownerId,
      projectId,
      await createParentRun(),
    );
    const run = await first.createRunning({
      workflowRunId,
      nodeId: 'scoped',
    });
    for (const repository of [otherProject, otherRun]) {
      await expect(repository.updateInputs(run.id, {})).rejects.toThrow();
      await expect(repository.markCompleted(run.id, {})).rejects.toThrow();
      await expect(
        repository.markFailed(run.id, {
          code: 'wrong',
          message: '错误范围',
          stage: 'execute',
        }),
      ).rejects.toThrow();
    }
    await expect(
      first.createRunning({
        workflowRunId: randomUUID(),
        nodeId: 'invalid',
      }),
    ).rejects.toThrow('不匹配');
    expect(
      await db.nodeRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({ status: 'running', inputs: null });
  });
});
