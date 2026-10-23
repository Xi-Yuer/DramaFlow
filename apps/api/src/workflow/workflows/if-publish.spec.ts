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

it.each([false, true, 'candidates'] as const)(
  '生产 Publish 仅放行安全 If：条件分支最终输出=%s',
  async (conditionalOutput) => {
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
      outputs:
        conditionalOutput === 'candidates'
          ? [
              {
                name: 'result',
                type: { kind: 'primitive', name: 'string' },
                sources: [
                  { nodeId: 'B', outputKey: 'text' },
                  { nodeId: 'C', outputKey: 'text' },
                ],
              },
            ]
          : conditionalOutput
            ? [
                {
                  name: 'result',
                  type: { kind: 'primitive', name: 'string' },
                  source: { nodeId: 'B', outputKey: 'text' },
                },
              ]
            : [],
    };
    const createVersion = vi.fn(
      async ({
        data,
      }: {
        data: {
          workflowId: string;
          sourceRevision: number;
          version: number;
          definition: unknown;
        };
      }) => ({
        ...data,
        id: 'published-if',
        createdAt: new Date('2026-10-23T00:00:00.000Z'),
      }),
    );
    const aggregateVersion = vi
      .fn()
      .mockResolvedValue({ _max: { version: null } });
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
    if (conditionalOutput === true) {
      await expect(
        service.publish('owner', {
          workflowId: 'workflow',
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'WORKFLOW_PUBLISH_VALIDATION_FAILED',
          message: expect.stringContaining('Compiler'),
          issues: [
            { code: 'CONDITIONAL_WORKFLOW_OUTPUT_UNSUPPORTED', nodeId: 'B' },
          ],
        },
      });
      expect(createVersion).not.toHaveBeenCalled();
      expect(aggregateVersion).not.toHaveBeenCalled();
      expect(assertModel).not.toHaveBeenCalled();
    } else {
      const published = await service.publish('owner', {
        workflowId: 'workflow',
        expectedRevision: 1,
      });
      expect(published).toMatchObject({
        id: 'published-if',
        workflowId: 'workflow',
        version: 1,
        sourceRevision: 1,
        definition: draft,
      });
      expect(createVersion).toHaveBeenCalledOnce();
      // 包含未选分支的模型绑定也沿用当前 Owner 的发布授权，不绕过既有权限。
      expect(assertModel).toHaveBeenCalledTimes(2);
      for (const call of assertModel.mock.calls) expect(call[1]).toBe('owner');
    }
  },
);
