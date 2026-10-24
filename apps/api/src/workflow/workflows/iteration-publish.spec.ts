import { expect, it, vi } from 'vitest';
import { StringType, type WorkflowDefinition } from '@dramaflow/contracts';
import type { Prisma } from '@dramaflow/database';
import type { DatabaseService, ModelProviderService } from '@dramaflow/server';
import {
  createIterationNodeType,
  createTextGenerationNodeType,
  NodeRegistry,
} from '@dramaflow/workflow';
import { WorkflowService } from './workflow.service.js';

it.each([false, true])(
  'Iteration 正式 Publish 递归校验 body 模型权限，拒绝=%s',
  async (denied) => {
    const modelConfigurationId = '00000000-0000-4000-8000-000000000001';
    const draft: WorkflowDefinition = {
      inputs: [],
      edges: [],
      outputs: [
        {
          name: 'texts',
          type: { kind: 'array', itemType: StringType },
          source: { nodeId: 'iterate', outputKey: 'text' },
        },
      ],
      nodes: [
        {
          id: 'iterate',
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
            bodyInputMapping: [
              { target: 'chapter', source: { type: 'current_item' } },
            ],
            body: {
              inputs: [{ name: 'chapter', type: StringType, required: true }],
              edges: [],
              nodes: [
                {
                  id: 'generate',
                  type: 'ai.text_generate',
                  typeVersion: 1,
                  name: '文本',
                  inputs: {
                    prompt: { type: 'workflow_input', key: 'chapter' },
                  },
                  config: { modelConfigurationId },
                  ui: { position: { x: 0, y: 0 } },
                },
              ],
              outputs: [
                {
                  name: 'text',
                  type: StringType,
                  source: { nodeId: 'generate', outputKey: 'text' },
                },
              ],
            },
          },
        },
      ],
    };
    const createVersion = vi.fn(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        id: 'version',
        createdAt: new Date('2026-10-24T00:00:00.000Z'),
      }),
    );
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([
          { id: 'workflow', projectId: 'project', revision: 1, draft },
        ]),
      workflowVersion: {
        findUnique: vi.fn().mockResolvedValue(null),
        aggregate: vi.fn().mockResolvedValue({ _max: { version: null } }),
        create: createVersion,
      },
    };
    const db = {
      client: {
        $transaction: async (
          work: (tx: Prisma.TransactionClient) => Promise<unknown>,
        ) => work(transaction as unknown as Prisma.TransactionClient),
      },
    } as unknown as DatabaseService;
    const error = new Error('模型权限拒绝');
    const assertModel = denied
      ? vi.fn().mockRejectedValue(error)
      : vi.fn().mockResolvedValue(undefined);
    const models = {
      assertPublishableConfiguration: assertModel,
    } as unknown as ModelProviderService;
    const service = new WorkflowService(
      db,
      new NodeRegistry([
        createIterationNodeType(),
        createTextGenerationNodeType(),
      ]),
      models,
    );
    if (denied) {
      await expect(
        service.publish('owner', {
          workflowId: 'workflow',
          expectedRevision: 1,
        }),
      ).rejects.toBe(error);
      expect(createVersion).not.toHaveBeenCalled();
    } else {
      await expect(
        service.publish('owner', {
          workflowId: 'workflow',
          expectedRevision: 1,
        }),
      ).resolves.toMatchObject({ id: 'version', definition: draft });
      expect(createVersion).toHaveBeenCalledOnce();
    }
    expect(assertModel).toHaveBeenCalledExactlyOnceWith(
      transaction,
      'owner',
      modelConfigurationId,
      'text.generate',
    );
  },
);
