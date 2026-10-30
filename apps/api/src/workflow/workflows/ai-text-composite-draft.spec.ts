import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  StringType,
  instantiateNodeCatalogEntry,
  workflowDraftDefinitionSchema,
  nodeCatalogEntrySchema,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import type { Prisma } from '@dramaflow/database';
import { type DatabaseService, type ModelProviderService } from '@dramaflow/server';
function createAiTextCompositeTestEntry() {
  return nodeCatalogEntrySchema.parse(
    JSON.parse(
      readFileSync(
        new URL(
          '../../../../../packages/server/test/fixtures/ai-text-composite-entry.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  );
}
import {
  NodeRegistry,
  createSubworkflowNodeType,
  createTextGenerationNodeType,
} from '@dramaflow/workflow';
import { WorkflowService } from './workflow.service.js';

describe('AI 文本 Composite 沿用 Draft / Reload / Publish 服务', () => {
  it('未选模型也可保存；嵌套修改和配置经存储重载保留，补齐后通过正式发布校验', async () => {
    const registry = new NodeRegistry([
      createSubworkflowNodeType(),
      createTextGenerationNodeType(),
    ]);
    const entry = createAiTextCompositeTestEntry();
    const node = instantiateNodeCatalogEntry(entry, registry.get('flow.subworkflow', 1).manifest, {
      id: 'process_text',
      position: { x: 320, y: 160 },
    });
    node.inputs.text = { type: 'workflow_input', key: 'text' };
    let stored = {
      id: 'workflow',
      projectId: '00000000-0000-4000-8000-000000000002',
      metadataRevision: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      name: '默认工作流',
      revision: 1,
      draft: workflowDraftDefinitionSchema.parse({ inputs: [], nodes: [], edges: [], outputs: [] }),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const tx = {
      $queryRaw: vi.fn(async () => [structuredClone(stored)]),
      workflow: {
        findFirst: vi.fn(async () => structuredClone(stored)),
        updateMany: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { revision: number };
            data: { draft: WorkflowDefinition };
          }) => {
            if (where.revision !== stored.revision) return { count: 0 };
            stored = {
              ...stored,
              draft: JSON.parse(JSON.stringify(data.draft)),
              revision: stored.revision + 1,
            };
            return { count: 1 };
          },
        ),
      },
      workflowVersion: {
        findUnique: vi.fn().mockResolvedValue(null),
        aggregate: vi.fn().mockResolvedValue({ _max: { version: null } }),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          id: 'version',
          createdAt: new Date(),
        })),
      },
    };
    const db = {
      client: {
        ...tx,
        $transaction: async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          work(tx as unknown as Prisma.TransactionClient),
      },
    } as unknown as DatabaseService;
    const assertModel = vi.fn().mockResolvedValue(undefined);
    const service = new WorkflowService(db, registry, {
      assertPublishableConfiguration: assertModel,
    } as unknown as ModelProviderService);
    const definition = workflowDraftDefinitionSchema.parse({
      inputs: [{ name: 'text', type: StringType, required: true }],
      nodes: [node],
      edges: [],
      outputs: [
        { name: 'result', type: StringType, source: { nodeId: node.id, outputKey: 'result' } },
      ],
    });
    await expect(
      service.updateDraft('owner', { workflowId: stored.id, expectedRevision: 1, definition }),
    ).resolves.toEqual({ revision: 2 });
    const first = await service.get('owner', stored.projectId, stored.id);
    expect(first.draft).toEqual(definition);
    expect(tx.workflowVersion.create).not.toHaveBeenCalled();
    expect(assertModel).not.toHaveBeenCalled();
    await expect(
      service.publish('owner', { workflowId: stored.id, expectedRevision: 2 }),
    ).rejects.toMatchObject({ response: { code: 'WORKFLOW_NODE_CONFIGURATION_INVALID' } });
    const composite = first.draft.nodes[0]!.composite;
    if (composite?.kind !== 'subworkflow') throw new Error('缺少子图');
    const action = composite.graph.nodes[0]!;
    const modelConfigurationId = '00000000-0000-4000-8000-000000000001';
    action.config = { modelConfigurationId };
    action.inputs.prompt = {
      type: 'template',
      value: '用一句话概括：{{text}}',
      variables: { text: { type: 'workflow_input', key: 'text' } },
    };
    action.inputs.system = { type: 'constant', value: '保留原文语言。' };
    await service.updateDraft('owner', {
      workflowId: stored.id,
      expectedRevision: 2,
      definition: first.draft,
    });
    // 保存后再改客户端对象，不能污染持久化快照。
    action.config = {};
    const reloaded = await service.get('owner', stored.projectId, stored.id);
    expect(reloaded.revision).toBe(3);
    const savedComposite = reloaded.draft.nodes[0]!.composite;
    if (savedComposite?.kind !== 'subworkflow') throw new Error('缺少子图');
    expect(savedComposite.graph.nodes[0]).toMatchObject({
      config: { modelConfigurationId },
      inputs: {
        prompt: {
          type: 'template',
          value: '用一句话概括：{{text}}',
          variables: { text: { type: 'workflow_input', key: 'text' } },
        },
        system: { type: 'constant', value: '保留原文语言。' },
      },
    });
    expect(entry.creation.composite).toEqual(createAiTextCompositeTestEntry().creation.composite);
    expect(tx.workflowVersion.create).not.toHaveBeenCalled();
    const published = await service.publish('owner', {
      workflowId: stored.id,
      expectedRevision: reloaded.revision,
    });
    expect(published.definition).toEqual(reloaded.draft);
    expect(assertModel).toHaveBeenCalledExactlyOnceWith(
      tx,
      'owner',
      modelConfigurationId,
      'text.generate',
    );
    expect(tx.workflowVersion.create).toHaveBeenCalledOnce();
    expect(tx.workflow.updateMany).toHaveBeenCalledTimes(2);
  });
});
