import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

// 仅建立本机开发草稿。只装配项目 / Draft 服务，不启动 Runtime、Worker 或 Outbox Pump。
async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const url = new URL(process.env.DATABASE_URL);
  if (
    process.env.NODE_ENV === 'production' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.pathname !== '/dramaflow'
  )
    throw new Error('仅允许本项目本机开发数据库');
  const ownerId = process.argv[2];
  if (!ownerId || process.argv.length !== 3) throw new Error('请显式提供已有账号的 ownerId');
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
  require('reflect-metadata');
  const { Module } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const {
    StringType,
    instantiateNodeCatalogEntry,
    workflowDraftDefinitionSchema,
    nodeCatalogEntrySchema,
  } = await import('../packages/contracts/dist/index.js');
  const { DatabaseModule, DatabaseService } = await import('../packages/server/dist/index.js');
  const { NodeRegistry } = await import('../packages/workflow/dist/index.js');
  const { ProjectsModule } = await import('../apps/api/dist/projects/projects.module.js');
  const { ProjectsService } = await import('../apps/api/dist/projects/projects.service.js');
  const { WorkflowsModule } =
    await import('../apps/api/dist/workflow/workflows/workflows.module.js');
  const { WorkflowService } =
    await import('../apps/api/dist/workflow/workflows/workflow.service.js');
  class AcceptanceModule {}
  Module({ imports: [DatabaseModule, ProjectsModule, WorkflowsModule] })(AcceptanceModule);
  const app = await NestFactory.createApplicationContext(AcceptanceModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    const db = app.get(DatabaseService).client;
    if (!(await db.user.findUnique({ where: { id: ownerId }, select: { id: true } })))
      throw new Error('账号不存在');
    const name = 'AI 文本处理 · Composite 验收';
    // 重复执行只报告现有草稿，避免覆盖人工编辑或重放创建。
    const existing = await db.project.findMany({
      where: { ownerId, name },
      select: { id: true },
    });
    if (existing.length > 1) throw new Error('存在多个同名验收项目，请先确认目标');
    const workflows = app.get(WorkflowService);
    let projectId = existing[0]?.id;
    if (!projectId) {
      const entry = nodeCatalogEntrySchema.parse(
        JSON.parse(
          readFileSync(
            new URL(
              '../packages/server/test/fixtures/ai-text-composite-entry.json',
              import.meta.url,
            ),
            'utf8',
          ),
        ),
      );
      const node = instantiateNodeCatalogEntry(
        entry,
        app.get(NodeRegistry).get(entry.target.type, entry.target.version).manifest,
        { id: 'process_text', position: { x: 320, y: 160 } },
      );
      node.inputs.text = { type: 'workflow_input', key: 'text' };
      const definition = workflowDraftDefinitionSchema.parse({
        inputs: [{ name: 'text', type: StringType, required: true }],
        nodes: [node],
        edges: [],
        outputs: [
          { name: 'result', type: StringType, source: { nodeId: node.id, outputKey: 'result' } },
        ],
      });
      const project = await app.get(ProjectsService).create(ownerId, { name });
      projectId = project.id;
      const workflow = await workflows.getForProject(ownerId, projectId);
      const saved = await workflows.updateDraft(ownerId, {
        workflowId: workflow.id,
        expectedRevision: workflow.revision,
        definition,
      });
      const reloaded = await workflows.getForProject(ownerId, projectId);
      if (reloaded.revision !== saved.revision || !isDeepStrictEqual(reloaded.draft, definition))
        throw new Error(`草稿重载不一致，检查项目 ${projectId}，不要重放创建`);
    }
    const workflow = await workflows.getForProject(ownerId, projectId);
    console.info(
      JSON.stringify({
        projectId,
        workflowId: workflow.id,
        revision: workflow.revision,
        url: `http://localhost:3000/projects/${projectId}`,
        versions: await db.workflowVersion.count({ where: { workflowId: workflow.id } }),
        runs: await db.workflowRun.count({ where: { workflowId: workflow.id } }),
        reused: existing.length > 0,
      }),
    );
  } finally {
    await app.close();
  }
}

try {
  await main();
} catch (error) {
  // 不打印驱动 / 配置原始错误，以免暴露本机秘密。
  console.error('验收草稿创建未完成；请检查构建、本机环境、ownerId 和项目列表，勿盲目重试。');
  if (error instanceof Error && !error.stack?.includes('node_modules'))
    console.error(error.message);
  process.exitCode = 1;
}
