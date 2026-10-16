import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@dramaflow/database';
import { emptyWorkflowDefinition } from '@dramaflow/contracts';
import type {
  ChatReply,
  ContextBundle,
  Conversation,
  ConversationSummary,
  HumanTask,
  JsonObject,
  PageResult,
  PluginConnection,
  WorkflowDefinition,
  WorkflowDraft,
  WorkflowRun,
  WorkflowVersion,
  Workspace,
} from '@dramaflow/contracts';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  !new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname.endsWith(
    '_test',
  )
)
  throw new Error(
    '请从仓库根执行 pnpm test:integration；禁止对业务数据库运行集成测试',
  );

const base = 'http://localhost:3101';
const children: ChildProcess[] = [];
const transport: { path: string; body: Record<string, unknown> }[] = [];
let logs = '';
let cookie = '';
let workspaceId = '';
let connection: PluginConnection;
const db = createDatabase();
const provider = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const part of req) chunks.push(Buffer.from(part));
  const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
    string,
    unknown
  >;
  transport.push({ path: req.url ?? '', body });
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/images/generations') {
    res.end(
      JSON.stringify({
        created: 1,
        data: [
          {
            b64_json:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFJ0AAAAASUVORK5CYII=',
          },
        ],
      }),
    );
    return;
  }
  const messages = body.messages as { role: string; content: string }[];
  const latest = messages.at(-1)?.content ?? '';
  const text = messages[0]?.content.startsWith('将给定的历史对话')
    ? '已确认：故事主角叫阿月，画面使用水墨风格。未决定：最终标题。'
    : latest.includes('提出改名建议')
      ? '建议如下：\n```workflow-proposal\n' +
        JSON.stringify({
          title: '重命名结果',
          explanation: '让结果名称更清楚',
          changes: [
            { kind: 'renameNode', nodeId: 'output', value: '确认后的结果' },
          ],
        }) +
        '\n```'
      : latest.includes('下一步拒绝')
        ? '拒绝测试内容'
        : '这是一段由本地测试供应商返回的文本。';
  res.end(
    JSON.stringify({
      id: `fixture-${transport.length}`,
      object: 'chat.completion',
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
    }),
  );
});

async function request<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  expected = 200,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      cookie,
      Origin: base,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data: unknown = await response.json();
  expect(response.status, JSON.stringify(data)).toBe(expected);
  return data as T;
}
function launch(path: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [path], {
    cwd: new URL('../../../', import.meta.url),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-24000);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-24000);
  });
  children.push(child);
  return child;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    delay(5000).then(() => child.kill('SIGKILL')),
  ]);
}
async function waitRun(id: string, status: WorkflowRun['status']) {
  for (let i = 0; i < 150; i++) {
    const run = await request<WorkflowRun>(`/runs/${id}`);
    if (run.status === status) return run;
    if (['failed', 'canceled'].includes(run.status))
      throw new Error(`运行意外终止：${JSON.stringify(run.error)}\n${logs}`);
    await delay(100);
  }
  throw new Error(`等待 ${status} 超时\n${logs}`);
}
async function createWorkflow(
  definition: WorkflowDefinition = emptyWorkflowDefinition,
) {
  const draft = await request<WorkflowDraft>(
    `/workspaces/${workspaceId}/workflows`,
    'POST',
    { name: `集成验证-${randomUUID().slice(0, 8)}` },
    201,
  );
  return request<WorkflowDraft>(`/workflows/${draft.id}`, 'PUT', {
    name: draft.name,
    description: '',
    revision: draft.revision,
    definition,
  });
}
const node = (
  id: string,
  type: WorkflowDefinition['nodes'][number]['type'],
  config: JsonObject = {},
) => ({
  id,
  type,
  version: '1.0.0',
  title: id,
  position: { x: 0, y: 0 },
  config,
});
const edge = (source: string, target: string, sourcePort = 'out') => ({
  id: `${source}-${target}-${sourcePort}`,
  source,
  target,
  sourcePort,
});

beforeAll(async () => {
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const env = {
    ...process.env,
    API_PORT: '3101',
    PORT: '3101',
    BETTER_AUTH_URL: base,
    WEB_ORIGIN: base,
    MODEL_ENDPOINT_ALLOWLIST: providerOrigin,
  };
  launch('apps/api/dist/main.js', env);
  for (let i = 0; i < 200; i++) {
    const ready = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(3000) })
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) break;
    if (i === 199) throw new Error(`API 启动失败\n${logs}`);
    await delay(100);
  }
  const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    }),
  });
  expect(signIn.status).toBe(200);
  cookie = signIn.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .join('; ');
  expect(cookie).not.toBe('');
  workspaceId = (await request<PageResult<Workspace>>('/workspaces')).items[0]!
    .id;
  await request(`/workspaces/${workspaceId}/plugins/openai`, 'PUT', {
    enabled: true,
    pluginVersion: '1.0.0',
  });
  connection = await request<PluginConnection>(
    `/workspaces/${workspaceId}/connections`,
    'POST',
    {
      name: '集成测试专用连接',
      pluginId: 'openai',
      pluginVersion: '1.0.0',
      configuration: { baseUrl: `${providerOrigin}/v1`, contextWindow: 16384 },
      credential: 'integration-only-key',
    },
    201,
  );
  launch('apps/worker/dist/main.js', env);
}, 60000);
afterAll(async () => {
  await Promise.all(children.map(stop));
  provider.close();
  provider.closeAllConnections();
  await db.$disconnect();
});

describe('真实数据库、HTTP API 与独立 worker', () => {
  it('隔离工作空间、拒绝过期草稿、不在连接响应暴露凭证', async () => {
    expect(connection.hasCredential).toBe(true);
    expect(JSON.stringify(connection)).not.toContain('integration-only-key');
    const foreign = await db.workspace.create({
      data: { slug: `foreign-${randomUUID()}`, name: '其他空间' },
    });
    await request(`/workspaces/${foreign.id}/workflows`, 'GET', undefined, 404);
    const draft = await createWorkflow();
    await request(
      `/workflows/${draft.id}`,
      'PUT',
      {
        name: draft.name,
        revision: draft.revision - 1,
        definition: draft.definition,
      },
      409,
    );
    const extension = await db.$queryRaw<
      { extname: string }[]
    >`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    expect(extension[0]?.extname).toBe('vector');
  });
  it('冻结版本，人工编辑后恢复；重复启动与重复审核不重复执行', async () => {
    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        node('input', 'input'),
        node('review', 'review', { prompt: '请确认' }),
        node('output', 'output'),
      ],
      controlEdges: [edge('input', 'review'), edge('review', 'output')],
      bindings: [
        {
          nodeId: 'review',
          port: 'value',
          source: { kind: 'input', path: 'story' },
          optional: false,
        },
        {
          nodeId: 'output',
          port: 'story',
          source: { kind: 'node', nodeId: 'review', port: 'value' },
          optional: false,
        },
      ],
    };
    const draft = await createWorkflow(definition);
    const version = await request<WorkflowVersion>(
      `/workflows/${draft.id}/publish`,
      'POST',
      {},
      201,
    );
    const start = {
      versionId: version.id,
      input: { story: '原始剧本' },
      idempotencyKey: randomUUID(),
    };
    const run = await request<WorkflowRun>(
      `/workflows/${draft.id}/runs`,
      'POST',
      start,
      201,
    );
    const repeat = await request<WorkflowRun>(
      `/workflows/${draft.id}/runs`,
      'POST',
      start,
      201,
    );
    expect(repeat.id).toBe(run.id);
    await waitRun(run.id, 'waiting');
    await request(`/workflows/${draft.id}`, 'PUT', {
      name: draft.name,
      revision: draft.revision,
      definition: emptyWorkflowDefinition,
    });
    const task = (await request<PageResult<HumanTask>>(`/runs/${run.id}/tasks`))
      .items[0]!;
    const response = {
      decision: 'approve',
      values: { value: '人工确认后的剧本' },
      idempotencyKey: randomUUID(),
    };
    await request(`/tasks/${task.id}/respond`, 'POST', response, 201);
    const result = await waitRun(run.id, 'succeeded');
    expect(result.workflowVersionId).toBe(version.id);
    expect(result.outputCollections.output).toEqual({
      story: '人工确认后的剧本',
    });
    const repeated = await fetch(`${base}/api/v1/tasks/${task.id}/respond`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(response),
    });
    expect([201, 409]).toContain(repeated.status);
    expect(await db.humanTask.count({ where: { runId: run.id } })).toBe(1);
  });
  it('文本与图片通过真实 SDK 传输，保存资产并支持节点分叉', async () => {
    const model = {
      pluginId: 'openai',
      pluginVersion: '1.0.0',
      connectionId: connection.id,
      modelId: 'integration-text',
    };
    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        node('input', 'input'),
        node('text', 'text', { prompt: '生成水墨故事', model }),
        node('image', 'image', {
          prompt: '根据故事画封面',
          model: { ...model, modelId: 'integration-image' },
        }),
        node('output', 'output'),
      ],
      controlEdges: [
        edge('input', 'text'),
        edge('text', 'image'),
        edge('image', 'output'),
      ],
      bindings: [
        {
          nodeId: 'image',
          port: 'context',
          source: { kind: 'node', nodeId: 'text', port: 'text' },
          optional: false,
        },
        {
          nodeId: 'output',
          port: 'cover',
          source: { kind: 'node', nodeId: 'image', port: 'images' },
          optional: false,
        },
      ],
    };
    const draft = await createWorkflow(definition);
    await request(`/workflows/${draft.id}/publish`, 'POST', {}, 201);
    const run = await request<WorkflowRun>(
      `/workflows/${draft.id}/runs`,
      'POST',
      { input: {}, idempotencyKey: randomUUID() },
      201,
    );
    const result = await waitRun(run.id, 'succeeded');
    const covers = result.outputCollections.output!.cover as {
      assetId: string;
      versionId: string;
    }[];
    expect(covers).toHaveLength(1);
    const image = await fetch(
      `${base}/api/v1/assets/${covers[0]!.versionId}/content`,
      { headers: { cookie } },
    );
    expect(image.status).toBe(200);
    expect(image.headers.get('Content-Type')).toContain('image/png');
    expect(
      transport.find((call) => call.path.endsWith('/images/generations'))?.body
        .prompt,
    ).toContain('本地测试供应商');
    const child = await request<WorkflowRun>(
      `/runs/${run.id}/regenerate`,
      'POST',
      {
        nodeId: 'image',
        continueDownstream: true,
        idempotencyKey: randomUUID(),
      },
      201,
    );
    const regenerated = await waitRun(child.id, 'succeeded');
    expect(regenerated.nodeResults.text?.reused).toBe(true);
    expect(regenerated.parentRunId).toBe(run.id);
    expect(regenerated.invalidatedNodeIds).toContain('output');
  });
  it('对话建议需确认、摘要保留原文并参与后续上下文', async () => {
    const draft = await createWorkflow();
    const conversation = await request<Conversation>(
      `/workflows/${draft.id}/conversations`,
      'POST',
      {
        scope: 'workflow',
        model: {
          pluginId: 'openai',
          pluginVersion: '1.0.0',
          connectionId: connection.id,
          modelId: 'integration-chat',
        },
      },
      201,
    );
    const proposal = await request<ChatReply>(
      `/conversations/${conversation.id}/messages`,
      'POST',
      { content: '提出改名建议' },
      201,
      { 'Idempotency-Key': randomUUID() },
    );
    expect(proposal.proposal?.status).toBe('pending');
    expect(
      (await request<WorkflowDraft>(`/workflows/${draft.id}`)).revision,
    ).toBe(draft.revision);
    const applied = await request<WorkflowDraft>(
      `/proposals/${proposal.proposal!.id}/apply`,
      'POST',
      { baseRevision: draft.revision },
      201,
    );
    expect(
      applied.definition.nodes.find((entry) => entry.id === 'output')?.title,
    ).toBe('确认后的结果');
    const again = await request<WorkflowDraft>(
      `/proposals/${proposal.proposal!.id}/apply`,
      'POST',
      { baseRevision: draft.revision },
      201,
    );
    expect(again.revision).toBe(applied.revision);
    for (let i = 0; i < 3; i++)
      await request(
        `/conversations/${conversation.id}/messages`,
        'POST',
        { content: `确认第${i}项：主角阿月，水墨风格` },
        201,
      );
    const count = await db.chatMessage.count({
      where: { conversationId: conversation.id },
    });
    const key = randomUUID();
    const summary = await request<ConversationSummary>(
      `/conversations/${conversation.id}/summarize`,
      'POST',
      { idempotencyKey: key },
      201,
    );
    expect(summary.content).toContain('阿月');
    expect(
      await db.chatMessage.count({
        where: { conversationId: conversation.id },
      }),
    ).toBe(count);
    const repeated = await request<ConversationSummary>(
      `/conversations/${conversation.id}/summarize`,
      'POST',
      { idempotencyKey: key },
      201,
    );
    expect(repeated.id).toBe(summary.id);
    const preview = await request<ContextBundle>(
      `/conversations/${conversation.id}/context-preview`,
      'POST',
      { content: '回顾设定' },
      201,
    );
    expect(
      preview.manifest.sources.some(
        (source) => source.kind === 'summary' && source.included,
      ),
    ).toBe(true);
  });
});
