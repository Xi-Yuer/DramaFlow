import type { APIRequestContext, Page } from '@playwright/test';
import {
  projectSchema,
  workflowResponseSchema,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { expect, origin, test } from './fixtures.js';

const imageManifest = {
  type: 'test.image',
  version: 1,
  executionKind: 'action',
  metadata: { name: '图片', category: 'image' },
  inputs: [],
  outputs: [
    { key: 'image', name: '图片', dataType: { kind: 'named', name: 'media.image' } },
    { key: 'caption', name: '说明', dataType: { kind: 'primitive', name: 'string' } },
  ],
  config: [],
};

function node(
  id: string,
  name: string,
  position: { x: number; y: number },
  type = 'ai.text_generate',
): WorkflowDefinition['nodes'][number] {
  return {
    id,
    type,
    typeVersion: 1,
    name,
    inputs: {},
    config: {},
    ui: { position },
  };
}

function definition(): WorkflowDefinition {
  return {
    inputs: [],
    nodes: [
      node('outline', '生成大纲', { x: 40, y: 40 }),
      node('cast', '人物', { x: 40, y: 220 }),
      node('picture', '场景图', { x: 40, y: 400 }, 'test.image'),
      node('script', '剧本', { x: 380, y: 24 }),
      node('polish', '润色', { x: 760, y: 24 }),
    ],
    edges: [
      {
        id: 'script-polish',
        kind: 'control',
        source: { nodeId: 'script' },
        target: { nodeId: 'polish' },
      },
    ],
    outputs: [],
  };
}

async function createProject(api: APIRequestContext) {
  const project = projectSchema.parse(
    await (
      await api.post('/api/v1/projects', {
        headers: { Origin: origin },
        data: { name: '模板变量测试' },
      })
    ).json(),
  );
  const workflow = await readWorkflow(api, project.id);
  const saved = await api.put(`/api/v1/workflows/${workflow.id}/draft`, {
    headers: { Origin: origin },
    data: { expectedRevision: workflow.revision, definition: definition() },
  });
  expect(saved.ok()).toBeTruthy();
  return project;
}

async function readWorkflow(api: APIRequestContext, projectId: string) {
  return workflowResponseSchema.parse(
    await (await api.get(`/api/v1/projects/${projectId}/workflow`)).json(),
  );
}

async function save(page: Page) {
  const response = page.waitForResponse(
    (item) => item.request().method() === 'PUT' && item.url().endsWith('/draft'),
  );
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  return response;
}

test('文本节点插入多个上游变量，保存刷新后恢复，并过滤下游和非字符串输出', async ({
  page,
  request,
}) => {
  const project = await createProject(request);
  await page.route('**/api/v1/workflow/node-types', async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      await route.fulfill({ response });
      return;
    }
    await route.fulfill({ json: [...body, imageManifest] });
  });
  await page.goto(`/projects/${project.id}`);
  const script = page.locator('.react-flow__node[data-id="script"]');
  const prompt = script.getByRole('textbox', { name: '提示词', exact: true });
  await prompt.fill('请根据 ');
  await script.getByRole('button', { name: '向提示词插入变量' }).click();
  const menu = page.getByRole('listbox', { name: '提示词的可用上游输出' });
  await expect(menu.getByRole('option', { name: '生成大纲 生成文本' })).toBeVisible();
  await expect(menu.getByRole('option', { name: '人物 生成文本' })).toBeVisible();
  await expect(menu.getByRole('option', { name: '场景图 说明' })).toBeVisible();
  await expect(menu.getByRole('option', { name: '场景图 图片' })).toHaveCount(0);
  await expect(menu.getByRole('option', { name: '润色 生成文本' })).toHaveCount(0);
  await expect(menu.getByRole('option', { name: '剧本 生成文本' })).toHaveCount(0);
  await menu.getByRole('option', { name: '生成大纲 生成文本' }).click();
  await prompt.pressSequentially(' 和 ');
  await script.getByRole('button', { name: '向提示词插入变量' }).click();
  await page
    .getByRole('listbox', { name: '提示词的可用上游输出', exact: true })
    .getByRole('option', { name: '人物 生成文本' })
    .click();
  await prompt.pressSequentially(' 生成剧本');
  await expect(prompt).toHaveValue('请根据 {{text}} 和 {{text2}} 生成剧本');
  await expect(script.getByRole('button', { name: '删除变量 生成大纲 生成文本' })).toBeVisible();
  await expect(script.getByRole('button', { name: '删除变量 人物 生成文本' })).toBeVisible();

  const system = script.getByRole('textbox', { name: '系统提示词', exact: true });
  await system.scrollIntoViewIfNeeded();
  await script.getByRole('button', { name: '向系统提示词插入变量' }).click();
  await page
    .getByRole('listbox', { name: '系统提示词的可用上游输出', exact: true })
    .getByRole('option', { name: '场景图 说明' })
    .click();
  await expect(system).toHaveValue('{{caption}}');

  const saved = await save(page);
  expect(saved.ok()).toBeTruthy();
  const stored = await readWorkflow(request, project.id);
  const scriptNode = stored.draft.nodes.find((item) => item.id === 'script');
  expect(scriptNode?.inputs).toEqual({
    prompt: {
      type: 'template',
      value: '请根据 {{text}} 和 {{text2}} 生成剧本',
      variables: {
        text: { type: 'node_output', nodeId: 'outline', portKey: 'text' },
        text2: { type: 'node_output', nodeId: 'cast', portKey: 'text' },
      },
    },
    system: {
      type: 'template',
      value: '{{caption}}',
      variables: { caption: { type: 'node_output', nodeId: 'picture', portKey: 'caption' } },
    },
  });
  expect(stored.draft.edges).toEqual(definition().edges);

  await page.reload();
  await expect(prompt).toHaveValue('请根据 {{text}} 和 {{text2}} 生成剧本');
  await expect(system).toHaveValue('{{caption}}');
  await script.getByRole('button', { name: '删除变量 生成大纲 生成文本' }).click();
  await expect(prompt).toHaveValue('请根据  和 {{text2}} 生成剧本');
  await expect(script.getByRole('button', { name: '删除变量 生成大纲 生成文本' })).toHaveCount(0);
  expect((await save(page)).ok()).toBeTruthy();
  const removed = await readWorkflow(request, project.id);
  expect(removed.draft.nodes.find((item) => item.id === 'script')?.inputs.prompt).toEqual({
    type: 'template',
    value: '请根据  和 {{text2}} 生成剧本',
    variables: { text2: { type: 'node_output', nodeId: 'cast', portKey: 'text' } },
  });
  expect(removed.draft.edges).toEqual(definition().edges);

  await script.getByRole('button', { name: '删除变量 人物 生成文本' }).click();
  expect((await save(page)).ok()).toBeTruthy();
  const plain = await readWorkflow(request, project.id);
  expect(plain.draft.nodes.find((item) => item.id === 'script')?.inputs.prompt).toEqual({
    type: 'constant',
    value: '请根据  和  生成剧本',
  });
  expect(plain.draft.nodes.find((item) => item.id === 'script')?.inputs.system).toEqual({
    type: 'template',
    value: '{{caption}}',
    variables: { caption: { type: 'node_output', nodeId: 'picture', portKey: 'caption' } },
  });
});
