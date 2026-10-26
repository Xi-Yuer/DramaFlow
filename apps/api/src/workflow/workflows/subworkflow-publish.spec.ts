import { describe, expect, it, vi } from 'vitest';
import {
  StringType,
  type GraphDefinition,
  type NodeDefinition,
} from '@dramaflow/contracts';
import type { Prisma } from '@dramaflow/database';
import type { DatabaseService, ModelProviderService } from '@dramaflow/server';
import {
  NodeRegistry,
  createSubworkflowNodeType,
  createIterationNodeType,
  createTextGenerationNodeType,
} from '@dramaflow/workflow';
import { WorkflowService } from './workflow.service.js';
import { validateWorkflowNodeConfigurations } from './validate-node-configurations.js';

function fixture(nested = false) {
  const modelConfigurationId = '00000000-0000-4000-8000-000000000001';
  const action: NodeDefinition = {
    id: 'generate',
    type: 'ai.text_generate',
    typeVersion: 1,
    name: '文本',
    inputs: { prompt: { type: 'workflow_input', key: 'prompt' } },
    config: { modelConfigurationId },
    ui: { position: { x: 0, y: 0 } },
  };
  const child: GraphDefinition = {
    inputs: [{ name: 'prompt', type: StringType, required: true }],
    nodes: [action],
    edges: [],
    outputs: [
      {
        name: 'text',
        type: StringType,
        source: { nodeId: 'generate', outputKey: 'text' },
      },
    ],
  };
  const call: NodeDefinition = {
    id: 'call',
    type: 'flow.subworkflow',
    typeVersion: 1,
    name: '子流程',
    inputs: { prompt: { type: 'constant', value: 'hello' } },
    config: {},
    ui: { position: { x: 0, y: 0 } },
    composite: { kind: 'subworkflow', graph: child },
  };
  let draft: GraphDefinition = {
    inputs: [],
    nodes: [call],
    edges: [],
    outputs: [
      {
        name: 'text',
        type: StringType,
        source: { nodeId: 'call', outputKey: 'text' },
      },
    ],
  };
  if (nested)
    draft = {
      inputs: [],
      edges: [],
      outputs: [],
      nodes: [
        {
          id: 'loop',
          type: 'flow.iteration',
          typeVersion: 1,
          name: '逐项',
          inputs: { items: { type: 'constant', value: [] } },
          config: {},
          ui: { position: { x: 0, y: 0 } },
          composite: {
            kind: 'iteration',
            itemType: StringType,
            invariantInputs: [],
            bodyInputMapping: [],
            body: draft,
          },
        },
      ],
    };
  const registry = new NodeRegistry([
    createSubworkflowNodeType(),
    createIterationNodeType(),
    createTextGenerationNodeType(),
  ]);
  const createVersion = vi.fn(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'version',
      workflowId: data.workflowId,
      version: data.version,
      sourceRevision: data.sourceRevision,
      createdAt: new Date('2026-10-26T00:00:00.000Z'),
      definition: data.definition,
    }),
  );
  const updateDraft = vi.fn().mockResolvedValue({ count: 1 });
  const tx = {
    $queryRaw: vi
      .fn()
      .mockResolvedValue([
        { id: 'workflow', projectId: 'project', revision: 1, draft },
      ]),
    workflow: { updateMany: updateDraft },
    workflowVersion: {
      findUnique: vi.fn().mockResolvedValue(null),
      aggregate: vi.fn().mockResolvedValue({ _max: { version: null } }),
      create: createVersion,
    },
  };
  const db = {
    client: {
      $transaction: async (
        work: (transaction: Prisma.TransactionClient) => Promise<unknown>,
      ) => work(tx as unknown as Prisma.TransactionClient),
    },
  } as unknown as DatabaseService;
  const assertModel = vi.fn().mockResolvedValue(undefined);
  const service = new WorkflowService(db, registry, {
    assertPublishableConfiguration: assertModel,
  } as unknown as ModelProviderService);
  return {
    service,
    registry,
    createVersion,
    updateDraft,
    assertModel,
    tx,
    draft,
    call,
    action,
    modelConfigurationId,
  };
}

describe('SubWorkflow Draft / 正式 Publish 静态边界', () => {
  it.each([false, true])(
    'Draft 可以保存内嵌定义（Iteration 包装=%s），不授权模型或创建版本',
    async (nested) => {
      const f = fixture(nested);
      await expect(
        f.service.updateDraft('owner', {
          workflowId: 'workflow',
          expectedRevision: 1,
          definition: f.draft,
        }),
      ).resolves.toEqual({ revision: 2 });
      expect(f.updateDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { draft: f.draft, revision: { increment: 1 } },
        }),
      );
      expect(f.assertModel).not.toHaveBeenCalled();
      expect(f.createVersion).not.toHaveBeenCalled();
    },
  );
  it('普通 Action 子图在模型授权后发布，不新增 Run', async () => {
    const f = fixture(false);
    await expect(
      f.service.publish('owner', {
        workflowId: 'workflow',
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({
      version: 1,
      workflowId: 'workflow',
      sourceRevision: 1,
    });
    expect(f.assertModel).toHaveBeenCalledExactlyOnceWith(
      f.tx,
      'owner',
      f.modelConfigurationId,
      'text.generate',
    );
    expect(f.createVersion).toHaveBeenCalledOnce();
  });
  it('Iteration body 内的 SubWorkflow 在模型授权后仍拒绝发布', async () => {
    const f = fixture(true);
    await expect(
      f.service.publish('owner', {
        workflowId: 'workflow',
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'WORKFLOW_PUBLISH_VALIDATION_FAILED',
        issues: [
          expect.objectContaining({
            code: 'ITERATION_BODY_CAPABILITY_UNSUPPORTED',
            nodeId: 'call',
          }),
        ],
      },
    });
    expect(f.assertModel).toHaveBeenCalledExactlyOnceWith(
      f.tx,
      'owner',
      f.modelConfigurationId,
      'text.generate',
    );
    expect(f.createVersion).not.toHaveBeenCalled();
  });
  it('子图 Candidate 在发布时拒绝，不创建版本', async () => {
    const f = fixture();
    if (f.call.composite?.kind !== 'subworkflow') throw new Error('fixture');
    const other = { ...f.action, id: 'other', name: '另一来源' };
    f.call.composite.graph.nodes.push(other, {
      ...f.action,
      id: 'join',
      name: '汇聚',
      inputs: {
        prompt: {
          type: 'candidate',
          sources: [
            { type: 'node_output', nodeId: 'generate', portKey: 'text' },
            { type: 'node_output', nodeId: 'other', portKey: 'text' },
          ],
        },
      },
    });
    await expect(
      f.service.publish('owner', {
        workflowId: 'workflow',
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'WORKFLOW_PUBLISH_VALIDATION_FAILED',
        issues: [
          expect.objectContaining({
            code: 'SUBWORKFLOW_GRAPH_CANDIDATE_UNSUPPORTED',
            nodeId: 'join',
            portKey: 'prompt',
          }),
        ],
      },
    });
    expect(f.assertModel).not.toHaveBeenCalled();
    expect(f.createVersion).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    '子图模型权限拒绝不能绕过（嵌套=%s）',
    async (nested) => {
      const f = fixture(nested);
      const denied = new Error('模型权限拒绝');
      f.assertModel.mockRejectedValue(denied);
      await expect(
        f.service.publish('owner', {
          workflowId: 'workflow',
          expectedRevision: 1,
        }),
      ).rejects.toBe(denied);
      expect(f.assertModel).toHaveBeenCalledExactlyOnceWith(
        f.tx,
        'owner',
        f.modelConfigurationId,
        'text.generate',
      );
      expect(f.createVersion).not.toHaveBeenCalled();
    },
  );
  it('child config 在 Publish 按完整 Schema 检查，Draft 仍允许未完成配置', async () => {
    const f = fixture();
    f.action.config = {};
    expect(() =>
      validateWorkflowNodeConfigurations(f.draft, f.registry),
    ).not.toThrow();
    await expect(
      f.service.publish('owner', {
        workflowId: 'workflow',
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      response: { code: 'WORKFLOW_NODE_CONFIGURATION_INVALID' },
    });
    expect(f.assertModel).not.toHaveBeenCalled();
    expect(f.createVersion).not.toHaveBeenCalled();
  });
  it.each(['child', 'parent'] as const)(
    'Draft 递归检查 %s 未声明 config 字段',
    async (location) => {
      const f = fixture(true);
      (location === 'child' ? f.action : f.call).config.secret = 'forbidden';
      await expect(
        f.service.updateDraft('owner', {
          workflowId: 'workflow',
          expectedRevision: 1,
          definition: f.draft,
        }),
      ).rejects.toMatchObject({
        response: { code: 'WORKFLOW_NODE_CONFIGURATION_INVALID' },
      });
      expect(f.updateDraft).not.toHaveBeenCalled();
    },
  );
  it('子图未知 capability binding 沿用应用层拒绝规则', async () => {
    const f = fixture();
    const declaration = createTextGenerationNodeType();
    f.registry.register({
      ...declaration,
      manifest: { ...declaration.manifest, type: 'test.capability' },
    });
    f.action.type = 'test.capability';
    await expect(
      f.service.publish('owner', {
        workflowId: 'workflow',
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      response: { code: 'WORKFLOW_CAPABILITY_BINDING_UNSUPPORTED' },
    });
    expect(f.assertModel).not.toHaveBeenCalled();
    expect(f.createVersion).not.toHaveBeenCalled();
  });
  it.each(['type', 'version'] as const)(
    'Publish 拒绝未知 child %s；Draft 保持可编辑',
    async (kind) => {
      const f = fixture();
      if (kind === 'type') f.action.type = 'test.missing';
      else f.action.typeVersion = 2;
      expect(() =>
        validateWorkflowNodeConfigurations(f.draft, f.registry),
      ).not.toThrow();
      await expect(
        f.service.publish('owner', {
          workflowId: 'workflow',
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({
        response: {
          issues: [
            expect.objectContaining({
              code: 'NODE_TYPE_UNAVAILABLE',
              nodeId: 'generate',
            }),
          ],
        },
      });
      expect(f.createVersion).not.toHaveBeenCalled();
    },
  );
});
