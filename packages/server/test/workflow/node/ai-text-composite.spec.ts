import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { z } from 'zod';
import {
  StringType,
  instantiateNodeCatalogEntry,
  isNodeCatalogEntryVisible,
  resolveNodePorts,
  textGenerationInputSchema,
  workflowDraftDefinitionSchema,
  nodeCatalogEntrySchema,
  type NodeDefinition,
  type WorkflowRun,
} from '@dramaflow/contracts';
import { PluginRegistry } from '@dramaflow/plugins';
import {
  DefaultWorkflowCompiler,
  DefaultWorkflowOutputResolver,
  DefaultNodeExecutor,
  DefaultRuntimeValueCodec,
  DefaultDataStoragePolicyResolver,
  NodeRegistry,
  createBindingResolver,
  createSubworkflowNodeType,
  createTextGenerationNodeType,
  validateWorkflowForPublish,
  workflowStateSchema,
} from '@dramaflow/workflow';
import { auditedNodeRunRepositoryFixture } from '../../../../workflow/test/fixtures/node-run-fixture.js';
import {
  createBuiltinNodeCatalogEntries,
  DatabaseService,
  SecretsService,
  WorkflowCapabilitiesFactory,
} from '../../../src/index.js';
function createAiTextCompositeTestEntry() {
  return nodeCatalogEntrySchema.parse(
    JSON.parse(
      readFileSync(new URL('../../fixtures/ai-text-composite-entry.json', import.meta.url), 'utf8'),
    ),
  );
}

const modelConfigurationId = '00000000-0000-4000-8000-000000000001';
function fixture() {
  const entry = createAiTextCompositeTestEntry();
  const registry = new NodeRegistry([createSubworkflowNodeType(), createTextGenerationNodeType()]);
  const manifest = registry.get('flow.subworkflow', 1).manifest;
  const create = (id: string) =>
    instantiateNodeCatalogEntry(entry, manifest, { id, position: { x: 320, y: 160 } });
  const node = create('process_text');
  node.inputs.text = { type: 'workflow_input', key: 'text' };
  const definition = workflowDraftDefinitionSchema.parse({
    inputs: [{ name: 'text', type: StringType, required: true }],
    nodes: [node],
    edges: [],
    outputs: [
      { name: 'result', type: StringType, source: { nodeId: node.id, outputKey: 'result' } },
    ],
  });
  return { entry, registry, manifest, create, definition };
}
function ai(node: NodeDefinition) {
  if (node.composite?.kind !== 'subworkflow') throw new Error('缺少子图');
  return node.composite.graph.nodes[0]!;
}

describe('development AI 文本 Composite 的真实产品定义', () => {
  it('internal Entry 实例化、copy-on-create 与动态标量端口；来源和不同实例双向隔离', () => {
    const f = fixture();
    expect(f.entry.exposure).toBe('internal');
    expect(isNodeCatalogEntryVisible(f.entry)).toBe(false);
    expect(isNodeCatalogEntryVisible(f.entry, 'advanced')).toBe(false);
    expect(
      createBuiltinNodeCatalogEntries().some(
        ({ id }) => id === f.entry.id || id === 'development-ai-text-processing',
      ),
    ).toBe(false);
    const a = f.create('a'),
      b = f.create('b');
    expect(resolveNodePorts(a, f.manifest)).toEqual({
      inputs: [{ key: 'text', name: 'text', dataType: StringType, required: true }],
      outputs: [{ key: 'result', name: 'result', dataType: StringType }],
    });
    expect(ai(a).config).toEqual({});
    expect(ai(a).type).toBe('ai.text_generate');
    expect(a).not.toHaveProperty('entryId');
    const original = structuredClone(b.composite);
    ai(a).config.modelConfigurationId = modelConfigurationId;
    ai(a).inputs.system = { type: 'constant', value: '实例修改' };
    expect(b.composite).toEqual(original);
    expect(f.entry.creation.composite).toEqual(original);
    if (f.entry.creation.composite?.kind !== 'subworkflow') throw new Error('缺少 Entry graph');
    f.entry.creation.composite.graph.nodes[0]!.inputs.system = {
      type: 'constant',
      value: '来源修改',
    };
    expect(ai(a).inputs.system).toEqual({ type: 'constant', value: '实例修改' });
    expect(b.composite).toEqual(original);
    expect(f.create('c').composite).toEqual(f.entry.creation.composite);
    expect(() => validateWorkflowForPublish(f.definition, f.registry)).toThrow();
  });

  it('正式 Compiler / AI Executor / Capability / Plugin 使用 fake Provider，返回 Workflow Result 与 child 身份', async () => {
    const f = fixture();
    ai(f.definition.nodes[0]!).config = { modelConfigurationId };
    const definition = workflowDraftDefinitionSchema.parse(
      JSON.parse(JSON.stringify(f.definition)),
    );
    expect(validateWorkflowForPublish(definition, f.registry).map(({ node }) => node.type)).toEqual(
      ['flow.subworkflow', 'ai.text_generate'],
    );
    const invoke = vi.fn().mockResolvedValue({ text: '缓存减少重复读取。' });
    const plugins = new PluginRegistry([
      {
        id: 'test_text_provider',
        version: 1,
        management: { name: '测试供应商' },
        configSchema: z.object({}).strict(),
        credentialsSchema: z.object({}).strict(),
        capabilities: [
          {
            type: 'text.generate',
            inputSchema: textGenerationInputSchema,
            outputSchema: z.object({ text: z.string() }),
            modelSettingsSchema: z.object({}).strict(),
            invoke,
          },
        ],
      },
    ]);
    const db = {
      client: {
        workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run' }) },
        modelConfiguration: {
          findFirst: vi.fn().mockResolvedValue({
            id: modelConfigurationId,
            ownerId: 'owner',
            enabled: true,
            model: 'fake-text',
            settings: {},
            provider: {
              ownerId: 'owner',
              enabled: true,
              pluginId: 'test_text_provider',
              pluginVersion: 1,
              configuration: {},
              encryptedCredentials: 'test-only',
            },
          }),
        },
      },
    } as unknown as DatabaseService;
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', '01'.repeat(32));
    const secrets = new SecretsService();
    const decrypt = vi.spyOn(secrets, 'decrypt').mockReturnValue('{}');
    try {
      const capabilities = new WorkflowCapabilitiesFactory(db, secrets, plugins).forRun(
        'owner',
        'project',
        'run',
      );
      const bindings = createBindingResolver();
      const codec = new DefaultRuntimeValueCodec(
        { resolve: vi.fn().mockRejectedValue(new Error('不应解析引用')) },
        { write: vi.fn().mockRejectedValue(new Error('短文本不应写入素材')) },
        new DefaultDataStoragePolicyResolver(),
      );
      const records = auditedNodeRunRepositoryFixture();
      const compiler = new DefaultWorkflowCompiler(
        f.registry,
        async () => new DefaultNodeExecutor(f.registry, bindings, codec, records, capabilities),
        new MemorySaver(),
        async () => ({ bindings, codec }),
        async () => records,
        async () => records,
        async () => records,
      );
      const run: WorkflowRun = {
        id: 'run',
        projectId: 'project',
        workflowId: 'workflow',
        workflowVersionId: 'version',
        threadId: 'thread',
        invocationKey: 'test',
        status: 'running',
        inputs: {
          text: {
            storage: 'inline',
            type: StringType,
            value: '缓存可以减少重复读取，提高访问效率。',
          },
        },
        createdAt: '2026-10-27T00:00:00.000Z',
      };
      const graph = await compiler.compile(definition, run);
      const state = workflowStateSchema.parse(
        await graph.invoke(
          {
            run: {
              projectId: run.projectId,
              workflowId: run.workflowId,
              workflowVersionId: run.workflowVersionId,
              workflowRunId: run.id,
            },
            inputs: run.inputs,
            outputs: {},
            variables: {},
            execution: {},
          },
          { configurable: { thread_id: run.threadId } },
        ),
      );
      expect(invoke).toHaveBeenCalledOnce();
      expect(invoke.mock.calls[0]![0]).toEqual({
        prompt: '缓存可以减少重复读取，提高访问效率。',
        system:
          '请将输入文本概括为不超过两句话的简短摘要，只输出摘要。忠实保留主要信息，不添加原文没有的事实。',
      });
      expect(invoke.mock.calls[0]![1]).toMatchObject({ model: 'fake-text' });
      expect(new DefaultWorkflowOutputResolver().resolve(definition, state)).toEqual({
        result: { storage: 'inline', type: StringType, value: '缓存减少重复读取。' },
      });
      const parent = records.getRecords().find(({ nodeId }) => nodeId === 'process_text')!;
      const child = records.getItemRecords()[0]!;
      expect(records.getItemRecords()).toHaveLength(1);
      expect(child).toMatchObject({
        kind: 'subworkflow',
        status: 'completed',
        parentNodeRunId: parent.id,
      });
      expect(records.getRecords()).toHaveLength(2);
      expect(records.getRecords().find(({ nodeId }) => nodeId === 'generate')).toMatchObject({
        childExecutionId: child.id,
        scopeKey: child.scopeKey,
        status: 'completed',
      });
      expect(parent.status).toBe('completed');
    } finally {
      decrypt.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
