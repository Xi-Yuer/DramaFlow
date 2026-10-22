import {
  DatabaseService,
  ModelProviderService,
  SecretsService,
  createModelCatalog,
  createProviderCatalog,
  createProviderPluginRegistry,
} from '@dramaflow/server';
import {
  StringType,
  workflowDefinitionSchema,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { NodeRegistry } from '@dramaflow/workflow';
import { z } from 'zod';
import { WorkflowService } from '../../src/workflow/workflows/workflow.service.js';

// 手动构造的集成服务仍使用真实插件、模型配置校验和数据库，不绕过 Publish。
export function createWorkflowService(
  database: DatabaseService,
  registry: NodeRegistry,
) {
  const plugins = createProviderPluginRegistry();
  const providers = createProviderCatalog(plugins);
  return new WorkflowService(
    database,
    registry,
    new ModelProviderService(
      database,
      new SecretsService(),
      plugins,
      providers,
      createModelCatalog(providers),
    ),
  );
}

export function registerTextTestNodes(registry: NodeRegistry): NodeRegistry {
  const prompt = z.object({ prompt: z.string() }).strict();
  const output = z.object({ text: z.string() }).strict();
  registry.register({
    manifest: {
      type: 'test.text',
      version: 1,
      executionKind: 'action',
      metadata: { name: '文本测试', category: 'data' },
      inputs: [{ key: 'prompt', name: '输入', dataType: StringType }],
      outputs: [{ key: 'text', name: '输出', dataType: StringType }],
      config: [{ key: 'style', name: '样式', type: 'string' }],
    },
    inputSchema: prompt,
    outputSchema: output,
    configSchema: z
      .object({ style: z.object({ tags: z.array(z.string()) }) })
      .strict(),
    async execute(input) {
      return { text: prompt.parse(input).prompt };
    },
  });
  const echo = z.object({ text: z.string(), context: z.string() }).strict();
  registry.register({
    manifest: {
      type: 'test.echo',
      version: 2,
      executionKind: 'action',
      metadata: { name: '输出测试', category: 'data' },
      inputs: [
        { key: 'text', name: '文本', dataType: StringType },
        { key: 'context', name: '上下文', dataType: StringType },
      ],
      outputs: [{ key: 'text', name: '输出', dataType: StringType }],
      config: [],
    },
    inputSchema: echo,
    outputSchema: output,
    configSchema: z.object({}).strict(),
    async execute(input) {
      return { text: echo.parse(input).text };
    },
  });
  return registry;
}

// 原生等待图 / 故障恢复用例显式建数：它们不是当前正式 Action 发布能力。
// 也用于验证历史不兼容快照仍会在 Runtime 被防御性拒绝，不声称这些版本通过正式发布。
export async function storeRuntimeTestVersion(
  database: DatabaseService,
  workflow: { id: string; projectId: string; revision: number },
  definition: WorkflowDefinition,
) {
  const previous = await database.client.workflowVersion.aggregate({
    where: { workflowId: workflow.id },
    _max: { version: true },
  });
  return database.client.workflowVersion.create({
    data: {
      workflowId: workflow.id,
      version: (previous._max.version ?? 0) + 1,
      sourceRevision: workflow.revision,
      definition: z
        .record(z.string(), z.json())
        .parse(workflowDefinitionSchema.parse(definition)),
    },
  });
}
