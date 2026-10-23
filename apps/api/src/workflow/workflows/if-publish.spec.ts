import { expect, it, vi } from 'vitest';
import { type WorkflowDefinition } from '@dramaflow/contracts';
import type { Prisma } from '@dramaflow/database';
import type { DatabaseService, ModelProviderService } from '@dramaflow/server';
import {
  createIfNodeType,
  createTextGenerationNodeType,
  NodeRegistry,
} from '@dramaflow/workflow';
import { WorkflowService } from './workflow.service.js';

it('生产 Publish 在创建不可变版本前拒绝静态合法的 If，不进入模型授权或运行路径', async () => {
  const draft: WorkflowDefinition = {
    inputs: [],
    nodes: [
      {
        id: 'if_1',
        type: 'flow.if',
        typeVersion: 1,
        name: '条件',
        inputs: { value: { type: 'constant', value: 'yes' } },
        config: { condition: { '===': [{ var: 'value' }, 'yes'] } },
        ui: { position: { x: 0, y: 0 } },
      },
      ...['B', 'C'].map((id) => ({
        id,
        type: 'ai.text_generate',
        typeVersion: 1,
        name: id,
        inputs: { prompt: { type: 'constant' as const, value: '文本' } },
        config: {
          modelConfigurationId: '00000000-0000-4000-8000-000000000001',
        },
        ui: { position: { x: 0, y: 0 } },
      })),
    ],
    edges: [
      {
        id: 'true',
        kind: 'control',
        source: { nodeId: 'if_1', portKey: 'true' },
        target: { nodeId: 'B' },
      },
      {
        id: 'false',
        kind: 'control',
        source: { nodeId: 'if_1', portKey: 'false' },
        target: { nodeId: 'C' },
      },
    ],
    outputs: [],
  };
  const createVersion = vi.fn();
  const aggregateVersion = vi.fn();
  const transaction = {
    $queryRaw: vi
      .fn()
      .mockResolvedValue([
        { id: 'workflow', projectId: 'project', revision: 1, draft },
      ]),
    workflowVersion: {
      findUnique: vi.fn().mockResolvedValue(null),
      aggregate: aggregateVersion,
      create: createVersion,
    },
  };
  // 只替换数据库与模型服务，实际执行生产 WorkflowService.publish 和领域校验。
  const db = {
    client: {
      $transaction: async (
        work: (tx: Prisma.TransactionClient) => Promise<unknown>,
      ) => work(transaction as unknown as Prisma.TransactionClient),
    },
  } as unknown as DatabaseService;
  const assertModel = vi.fn();
  const models = {
    assertPublishableConfiguration: assertModel,
  } as unknown as ModelProviderService;
  const service = new WorkflowService(
    db,
    new NodeRegistry([createTextGenerationNodeType(), createIfNodeType()]),
    models,
  );
  await expect(
    service.publish('owner', { workflowId: 'workflow', expectedRevision: 1 }),
  ).rejects.toMatchObject({
    response: {
      code: 'WORKFLOW_PUBLISH_VALIDATION_FAILED',
      message: expect.stringContaining('Compiler'),
      issues: [{ code: 'NODE_EXECUTION_KIND_UNSUPPORTED', nodeId: 'if_1' }],
    },
  });
  expect(createVersion).not.toHaveBeenCalled();
  expect(aggregateVersion).not.toHaveBeenCalled();
  expect(assertModel).not.toHaveBeenCalled();
});
