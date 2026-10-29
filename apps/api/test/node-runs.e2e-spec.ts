import { randomUUID } from 'node:crypto';
import { END, START, StateGraph, MemorySaver } from '@langchain/langgraph';
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
  WorkflowVersionRepositories,
} from '@dramaflow/server';
import {
  ActionNodeCompilationStrategy,
  createBindingResolver,
  deriveChildScope,
  DefaultDataStoragePolicyResolver,
  DefaultNodeExecutor,
  DefaultWorkflowCompiler,
  DefaultWorkflowRunner,
  DefaultWorkflowOutputResolver,
  createHumanReviewNodeType,
  DefaultRuntimeValueCodec,
  NodeRegistry,
  WorkflowStateAnnotation,
  type ArtifactWriter,
  type DataReferenceResolver,
  type LangGraphNode,
  type WorkflowState,
  type HumanReviewNodeRunRepository,
  type CreateNodeRunInput,
} from '@dramaflow/workflow';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !== '/dramaflow_test'
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

async function createParentRun(owner = ownerId, project = projectId): Promise<string> {
  const repository = await workflowRuns.forProject(owner, project);
  const run = await repository.create({
    projectId: project,
    workflowId: 'workflow',
    workflowVersionId: 'version',
    invocationKey: randomUUID(),
    inputs: {},
  });
  await repository.markRunning(run.id);
  return run.id;
}

async function createRootAttempt(
  repository: HumanReviewNodeRunRepository,
  input: Omit<CreateNodeRunInput, 'occurrenceId'>,
) {
  const occurrence = await repository.getOrCreateOccurrence({
    workflowRunId: input.workflowRunId,
    nodeId: input.nodeId,
    scopeKey: 'root',
  });
  return repository.createRunning({ ...input, occurrenceId: occurrence.id });
}

async function videoFixture() {
  const workflowRunId = await createParentRun();
  const repository = await repositories.forRun(ownerId, projectId, workflowRunId);
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
    new DefaultRuntimeValueCodec({ resolve }, { write }, new DefaultDataStoragePolicyResolver()),
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
    executionContext: (config) => ({
      scopeKey: 'root',
      workflow,
      runnableConfig: config,
    }),
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

// 复用现有隔离库设施，不启动 HTTP / Worker / Provider。
async function reviewFixture(running = true, includeAction = false) {
  const definition: WorkflowDefinition = {
    inputs: [],
    nodes: ['R1', 'R2'].map((id) => ({
      id,
      type: 'flow.human_review',
      typeVersion: 1,
      name: '人工审核',
      inputs: { content: { type: 'constant', value: ' 原审核文本\n' } },
      config: {},
      ui: { position: { x: 0, y: 0 } },
    })),
    edges: [
      {
        id: 'review-order',
        kind: 'control',
        source: { nodeId: 'R1' },
        target: { nodeId: 'R2' },
      },
    ],
    outputs: [],
  };
  if (includeAction)
    definition.nodes.push({
      id: 'action',
      type: 'test.action',
      typeVersion: 1,
      name: '本地操作',
      inputs: {},
      config: {},
      ui: { position: { x: 0, y: 0 } },
    });
  const json = z.record(z.string(), z.json()).parse(definition);
  const workflow = await db.workflow.upsert({
    where: { projectId },
    create: { projectId, name: '审核审计测试', draft: json },
    update: {},
  });
  const previous = await db.workflowVersion.aggregate({
    where: { workflowId: workflow.id },
    _max: { version: true },
  });
  const versionNumber = (previous._max.version ?? 0) + 1;
  const version = await db.workflowVersion.create({
    data: {
      workflowId: workflow.id,
      version: versionNumber,
      sourceRevision: versionNumber,
      definition: json,
    },
  });
  const runs = await workflowRuns.forProject(ownerId, projectId);
  const run = await runs.create({
    projectId,
    workflowId: workflow.id,
    workflowVersionId: version.id,
    invocationKey: randomUUID(),
    inputs: {},
  });
  if (running) await runs.markRunning(run.id);
  const repository = await repositories.forRun(ownerId, projectId, run.id);
  const input = {
    workflowRunId: run.id,
    workflowVersionId: version.id,
    nodeId: 'R1',
    occurrenceId: (
      await repository.getOrCreateOccurrence({
        workflowRunId: run.id,
        nodeId: 'R1',
        scopeKey: 'root',
      })
    ).id,
  };
  return { repository, input, runs, run, definition };
}
const reviewInput = {
  content: {
    storage: 'inline' as const,
    type: StringType,
    value: ' 原审核文本\n',
  },
};

describe('真实 PostgreSQL occurrence 身份与 attempt 分配', () => {
  it('并发解析 root 身份只创建一个 occurrence，不同 scope 各自从 attempt 1 原子分配', async () => {
    const workflowRunId = await createParentRun();
    const first = await repositories.forRun(ownerId, projectId, workflowRunId);
    const second = await repositories.forRun(ownerId, projectId, workflowRunId);
    const identity = { workflowRunId, nodeId: 'process', scopeKey: 'root' };
    const roots = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? first : second).getOrCreateOccurrence(identity),
      ),
    );
    expect(new Set(roots.map((item) => item.id)).size).toBe(1);
    const root = roots[0]!;
    const ownerOccurrence = await first.getOrCreateOccurrence({
      workflowRunId,
      nodeId: 'owner',
      scopeKey: 'root',
    });
    const owner = await first.createRunning({
      workflowRunId,
      nodeId: 'owner',
      occurrenceId: ownerOccurrence.id,
    });
    const childScope = deriveChildScope('root', {
      kind: 'iteration_item',
      ownerOccurrenceId: ownerOccurrence.id,
      ownerNodeRunId: owner.id,
      slot: 'body',
      index: 0,
    });
    const execution = await first.getOrCreateIterationItemRunning({
      workflowRunId,
      parentNodeRunId: owner.id,
      parentNodeId: 'owner',
      scopeKey: childScope,
      index: 0,
    });
    const child = await first.getOrCreateOccurrence({
      ...identity,
      scopeKey: childScope,
    });
    expect(
      await second.getOrCreateOccurrence({
        ...identity,
        scopeKey: childScope,
      }),
    ).toEqual(child);
    expect(child.id).not.toBe(root.id);
    const rows = await Promise.all(
      [root, child].map(async (occurrence) =>
        Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            (i % 2 ? first : second).createRunning({
              workflowRunId,
              nodeId: 'process',
              occurrenceId: occurrence.id,
              ...(occurrence.id === child.id ? { childExecutionId: execution.id } : {}),
            }),
          ),
        ),
      ),
    );
    for (const [index, occurrence] of [root, child].entries()) {
      expect(rows[index]!.map((row) => row.attempt).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      expect(new Set(rows[index]!.map((row) => row.occurrenceId))).toEqual(
        new Set([occurrence.id]),
      );
      expect(rows[index]!.every((row) => row.scopeKey === occurrence.scopeKey)).toBe(true);
    }
    expect(await second.getOrCreateOccurrence(identity)).toEqual(root);
    expect(await db.nodeOccurrence.count({ where: { workflowRunId, nodeId: 'process' } })).toBe(2);
    await expect(
      db.nodeRun.create({
        data: {
          projectId,
          workflowRunId,
          nodeId: 'process',
          occurrenceId: child.id,
          childExecutionId: execution.id,
          attempt: 1,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('occurrence 不能跨 node / Run 拼接，数据库外键独立于仓储校验', async () => {
    const workflowRunId = await createParentRun();
    const repository = await repositories.forRun(ownerId, projectId, workflowRunId);
    const occurrence = await repository.getOrCreateOccurrence({
      workflowRunId,
      nodeId: 'A',
      scopeKey: 'root',
    });
    const otherRunId = await createParentRun();
    const other = await repositories.forRun(ownerId, projectId, otherRunId);
    await expect(
      repository.createRunning({
        workflowRunId,
        nodeId: 'B',
        occurrenceId: occurrence.id,
      }),
    ).rejects.toThrow('不匹配');
    await expect(
      other.createRunning({
        workflowRunId: otherRunId,
        nodeId: 'A',
        occurrenceId: occurrence.id,
      }),
    ).rejects.toThrow('不匹配');
    for (const [parent, nodeId] of [
      [workflowRunId, 'B'],
      [otherRunId, 'A'],
    ])
      await expect(
        db.nodeRun.create({
          data: {
            projectId,
            workflowRunId: parent!,
            nodeId: nodeId!,
            occurrenceId: occurrence.id,
            attempt: 1,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    expect(await db.nodeRun.count({ where: { workflowRunId } })).toBe(0);
  });
});

describe('真实 PostgreSQL Human Review 重入审计', () => {
  it('同名审核的不同 scope 各有独立 occurrence 和 running attempt，重入不交叉复用', async () => {
    const f = await reviewFixture();
    const root = await f.repository.getOrCreateHumanReviewRunning(f.input);
    const execution = await f.repository.getOrCreateChildExecutionRunning({
      workflowRunId: f.run.id,
      parentNodeRunId: root.id,
      parentNodeId: 'R1',
      scopeKey: 'opaque-item-scope',
      kind: 'test_scope',
      invocationKey: 'review-child',
      metadata: {},
    });
    const child = await f.repository.getOrCreateOccurrence({
      workflowRunId: f.run.id,
      nodeId: 'R1',
      scopeKey: 'opaque-item-scope',
    });
    const other = await f.repository.getOrCreateHumanReviewRunning({
      ...f.input,
      occurrenceId: child.id,
      childExecutionId: execution.id,
    });
    expect(other).toMatchObject({
      occurrenceId: child.id,
      childExecutionId: execution.id,
      attempt: 1,
      status: 'running',
    });
    expect(other.id).not.toBe(root.id);
    expect(await f.repository.getOrCreateHumanReviewRunning(f.input)).toMatchObject({
      id: root.id,
      occurrenceId: root.occurrenceId,
      attempt: 1,
    });
    expect(
      await f.repository.getOrCreateHumanReviewRunning({
        ...f.input,
        occurrenceId: child.id,
        childExecutionId: execution.id,
      }),
    ).toMatchObject({ id: other.id, attempt: 1 });
  });
  it('多 Repository 并发获取仅创建 attempt 1；inputs 一次记录，恢复读取原记录', async () => {
    const f = await reviewFixture();
    const other = await repositories.forRun(ownerId, projectId, f.run.id);
    const rows = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? other : f.repository).getOrCreateHumanReviewRunning(f.input),
      ),
    );
    expect(new Set(rows.map((row) => row.id)).size).toBe(1);
    expect(new Set(rows.map((row) => row.occurrenceId))).toEqual(new Set([f.input.occurrenceId]));
    expect(rows.every((row) => row.attempt === 1 && row.status === 'running')).toBe(true);
    const id = rows[0]!.id;
    await f.repository.updateInputs(id, reviewInput);
    await expect(other.updateInputs(id, reviewInput)).rejects.toThrow();
    await f.runs.markWaiting(f.run.id);
    expect(await db.nodeRun.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'running',
      inputs: reviewInput,
      outputs: null,
      error: null,
    });
    await expect(other.getOrCreateHumanReviewRunning(f.input)).rejects.toThrow('claim');
    await f.runs.claimWaitingForResume(f.run.id);
    expect(await other.getOrCreateHumanReviewRunning(f.input)).toMatchObject({
      id,
      occurrenceId: f.input.occurrenceId,
      attempt: 1,
      inputs: reviewInput,
    });
    expect(
      await db.nodeRun.count({
        where: { workflowRunId: f.run.id, nodeId: 'R1' },
      }),
    ).toBe(1);
  });
  it.each(['completed', 'failed'] as const)(
    '不复用 %s 历史，不自动创建下一次审核 attempt',
    async (terminal) => {
      const f = await reviewFixture();
      const first = await f.repository.getOrCreateHumanReviewRunning(f.input);
      await f.repository.updateInputs(first.id, reviewInput);
      if (terminal === 'completed') await f.repository.markCompleted(first.id, {});
      else
        await f.repository.markFailed(first.id, {
          stage: 'execute',
          message: '决策无效',
        });
      await expect(f.repository.getOrCreateHumanReviewRunning(f.input)).rejects.toThrow('已结束');
      expect(
        await db.nodeRun.count({
          where: { workflowRunId: f.run.id, nodeId: 'R1' },
        }),
      ).toBe(1);
    },
  );
  it('拒绝错误版本、非 Human Review、其他 Run / owner 和多 attempt 历史', async () => {
    const f = await reviewFixture(true, true);
    await expect(
      f.repository.getOrCreateHumanReviewRunning({
        ...f.input,
        workflowVersionId: 'wrong-version',
      }),
    ).rejects.toThrow('固定版本');
    await expect(
      f.repository.getOrCreateHumanReviewRunning({
        ...f.input,
        nodeId: 'missing',
      }),
    ).rejects.toThrow('occurrence');
    await expect(
      f.repository.getOrCreateHumanReviewRunning({
        ...f.input,
        workflowRunId: randomUUID(),
      }),
    ).rejects.toThrow('不匹配');
    await expect(repositories.forRun(otherId, projectId, f.run.id)).rejects.toThrow('无权访问');
    // 即使已有普通 Action 风格 attempt 历史，也不能猜 latest running 来复用。
    await createRootAttempt(f.repository, f.input);
    await createRootAttempt(f.repository, f.input);
    await expect(f.repository.getOrCreateHumanReviewRunning(f.input)).rejects.toThrow(
      'attempt 历史',
    );
    expect(
      await db.nodeRun.count({
        where: { workflowRunId: f.run.id, nodeId: 'R1' },
      }),
    ).toBe(2);
  });
  it.each(['approve', 'reject'])(
    '正式策略 + Runner 两次串行等待恢复，最终 %s 审核仍为 completed attempt 1',
    async (action) => {
      const f = await reviewFixture(false);
      const codec = new DefaultRuntimeValueCodec(
        { resolve: vi.fn() },
        { write: vi.fn() },
        new DefaultDataStoragePolicyResolver(),
      );
      const compiler = new DefaultWorkflowCompiler(
        new NodeRegistry([createHumanReviewNodeType()]),
        async () => {
          throw new Error('审核不得创建 Action Executor');
        },
        new MemorySaver(),
        async () => ({ bindings: createBindingResolver(), codec }),
        async () => f.repository,
      );
      const versions = await new WorkflowVersionRepositories(database).forProject(
        ownerId,
        projectId,
      );
      const runner = new DefaultWorkflowRunner(
        versions,
        f.runs,
        compiler,
        new DefaultWorkflowOutputResolver(),
      );
      expect(await runner.executeStart(f.run.id)).toMatchObject({
        status: 'waiting',
      });
      const first = await db.nodeRun.findMany({
        where: { workflowRunId: f.run.id },
      });
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        nodeId: 'R1',
        attempt: 1,
        status: 'running',
        inputs: reviewInput,
        outputs: null,
        error: null,
      });
      expect(
        await runner.executeResume({
          workflowRunId: f.run.id,
          value: { action: 'approve' },
        }),
      ).toMatchObject({ status: 'waiting' });
      const waiting = await db.workflowRun.findUniqueOrThrow({
        where: { id: f.run.id },
      });
      expect(waiting.waitingRevision).toBe(2);
      expect(
        await runner.executeResume({
          workflowRunId: f.run.id,
          value: { action, feedback: '正式审计反馈' },
        }),
      ).toMatchObject({ status: 'completed' });
      const rows = await db.nodeRun.findMany({
        where: { workflowRunId: f.run.id },
        orderBy: { nodeId: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        id: first[0]!.id,
        nodeId: 'R1',
        attempt: 1,
        status: 'completed',
        inputs: reviewInput,
        outputs: {
          ...reviewInput,
          action: { storage: 'inline', type: StringType, value: 'approve' },
          feedback: { storage: 'inline', type: StringType, value: '' },
        },
      });
      expect(rows[1]).toMatchObject({
        nodeId: 'R2',
        attempt: 1,
        status: 'completed',
        inputs: reviewInput,
        outputs: {
          ...reviewInput,
          action: { storage: 'inline', type: StringType, value: action },
          feedback: {
            storage: 'inline',
            type: StringType,
            value: '正式审计反馈',
          },
        },
      });
    },
  );
  it('非法 resume decision 在同一条审核上写 failed', async () => {
    const f = await reviewFixture(false);
    const codec = new DefaultRuntimeValueCodec(
      { resolve: vi.fn() },
      { write: vi.fn() },
      new DefaultDataStoragePolicyResolver(),
    );
    const compiler = new DefaultWorkflowCompiler(
      new NodeRegistry([createHumanReviewNodeType()]),
      async () => {
        throw new Error('审核不得创建 Action Executor');
      },
      new MemorySaver(),
      async () => ({ bindings: createBindingResolver(), codec }),
      async () => f.repository,
    );
    const versions = await new WorkflowVersionRepositories(database).forProject(ownerId, projectId);
    const runner = new DefaultWorkflowRunner(
      versions,
      f.runs,
      compiler,
      new DefaultWorkflowOutputResolver(),
    );
    await runner.executeStart(f.run.id);
    await expect(
      runner.executeResume({
        workflowRunId: f.run.id,
        value: { action: 'invalid' },
      }),
    ).rejects.toMatchObject({ code: 'NODE_EXECUTION_FAILED' });
    const rows = await db.nodeRun.findMany({
      where: { workflowRunId: f.run.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      nodeId: 'R1',
      attempt: 1,
      status: 'failed',
      inputs: reviewInput,
      outputs: null,
      error: { stage: 'execute', code: 'NODE_EXECUTION_FAILED' },
    });
  });
});

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
    const repository = await repositories.forRun(ownerId, projectId, workflowRunId);
    const first = await createRootAttempt(repository, {
      workflowRunId,
      nodeId: 'image-1',
    });
    const second = await createRootAttempt(repository, {
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
    f.execute.mockRejectedValueOnce(new Error('provider-credential-test-marker'));
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
      expect(row.completedAt!.getTime()).toBeGreaterThanOrEqual(row.startedAt.getTime());
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
    expect(JSON.stringify(rows)).not.toContain('provider-credential-test-marker');
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
        scopeKey: 'root',
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
        createRootAttempt(index % 2 ? first : second, input),
      ),
    );
    expect(runs.map((run) => run.attempt).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(new Set(runs.map((run) => run.id)).size).toBe(12);
    expect((await createRootAttempt(first, { ...input, nodeId: 'different' })).attempt).toBe(1);
    await expect(
      db.nodeRun.create({
        data: {
          projectId,
          workflowRunId,
          nodeId: 'concurrent',
          occurrenceId: runs[0]!.occurrenceId,
          attempt: 1,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('inputs 只记录一次，completed / failed 历史不被改写', async () => {
    const workflowRunId = await createParentRun();
    const repo = await repositories.forRun(ownerId, projectId, workflowRunId);
    const run = await createRootAttempt(repo, {
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
    expect(await db.nodeRun.findUniqueOrThrow({ where: { id: run.id } })).toEqual(before);
    const failed = await createRootAttempt(repo, {
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
    expect(await db.nodeRun.findUniqueOrThrow({ where: { id: failed.id } })).toEqual(
      failedSnapshot,
    );
  });

  it('限定所有者、项目与运行，不能凭 NodeRun ID 写其他范围的历史', async () => {
    const workflowRunId = await createParentRun();
    await expect(repositories.forRun(otherId, projectId, workflowRunId)).rejects.toThrow(
      '无权访问',
    );
    const first = await repositories.forRun(ownerId, projectId, workflowRunId);
    const otherProject = await repositories.forRun(
      otherId,
      otherProjectId,
      await createParentRun(otherId, otherProjectId),
    );
    const otherRun = await repositories.forRun(ownerId, projectId, await createParentRun());
    const run = await createRootAttempt(first, {
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
      createRootAttempt(first, {
        workflowRunId: randomUUID(),
        nodeId: 'invalid',
      }),
    ).rejects.toThrow('不匹配');
    expect(await db.nodeRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: 'running',
      inputs: null,
    });
  });
});
