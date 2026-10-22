import type { APIRequestContext, Locator, Page } from '@playwright/test';
import {
  projectSchema,
  workflowResponseSchema,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { expect, origin, test } from './fixtures.js';

const replaceTitle = '该输入已有内容。连接后将改为使用上游节点输出，当前内容将被替换。';

function textNode(
  id: string,
  name: string,
  position: { x: number; y: number },
  inputs: WorkflowDefinition['nodes'][number]['inputs'] = {},
): WorkflowDefinition['nodes'][number] {
  return {
    id,
    type: 'ai.text_generate',
    typeVersion: 1,
    name,
    inputs,
    config: {},
    ui: { position },
  };
}

function definition(): WorkflowDefinition {
  const templateSource = 'src-template';
  return {
    inputs: [{ name: 'topic', type: { kind: 'primitive', name: 'string' } }],
    nodes: [
      textNode('src-blank', '空白来源', { x: 24, y: 40 }),
      textNode('blank', '空白', { x: 400, y: 40 }),
      textNode('src-constant', '常量来源', { x: 800, y: 40 }),
      textNode('constant', '常量', { x: 1176, y: 40 }, {
        prompt: { type: 'constant', value: '保持这段提示词' },
      }),
      textNode(templateSource, '模板来源', { x: 24, y: 640 }),
      textNode('template', '模板', { x: 400, y: 640 }, {
        prompt: {
          type: 'template',
          value: '请根据 {{text}} 写剧本',
          variables: {
            text: { type: 'node_output', nodeId: templateSource, portKey: 'text' },
          },
        },
      }),
      textNode('src-reference', '引用来源', { x: 800, y: 640 }),
      textNode('reference', '引用', { x: 1176, y: 640 }, {
        prompt: { type: 'workflow_input', key: 'topic' },
      }),
      textNode('src-asset', '资产来源', { x: 1600, y: 640 }),
      textNode('asset', '资产', { x: 1976, y: 640 }, {
        prompt: { type: 'asset', assetId: 'image-v1', versionId: 'asset-version-1' },
      }),
    ],
    edges: [],
    outputs: [],
  };
}

async function createProject(api: APIRequestContext) {
  const project = projectSchema.parse(
    await (
      await api.post('/api/v1/projects', {
        headers: { Origin: origin },
        data: { name: '连线替换确认' },
      })
    ).json(),
  );
  const workflow = workflowResponseSchema.parse(
    await (await api.get(`/api/v1/projects/${project.id}/workflow`)).json(),
  );
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

function node(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

async function connectPrompt(page: Page, sourceId: string, targetId: string) {
  const source = node(page, sourceId).locator('.react-flow__handle[data-handleid="text"]');
  const target = node(page, targetId).locator('.react-flow__handle[data-handleid="prompt"]');
  await expect(page.locator('.ant-modal-wrap')).toHaveCount(0);
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('连线端口不可见');
  const point = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y, { steps: 20 });
  await page.mouse.up();
}

function replaceDialog(page: Page) {
  return page.getByRole('dialog', { name: replaceTitle });
}

async function save(page: Page) {
  const response = page.waitForResponse(
    (item) => item.request().method() === 'PUT' && item.url().endsWith('/draft'),
  );
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  return response;
}

function prompt(nodeLocator: Locator) {
  return nodeLocator.getByRole('group', { name: '提示词', exact: true });
}

test('已有输入内容时连接前确认，取消保持原图，确认后才改为 Data Edge', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 2400, height: 1400 });
  const project = await createProject(request);
  await page.goto(`/projects/${project.id}`);
  const blank = node(page, 'blank');
  const constant = node(page, 'constant');
  const template = node(page, 'template');
  const reference = node(page, 'reference');
  const asset = node(page, 'asset');
  await expect(prompt(constant).getByRole('textbox')).toHaveValue('保持这段提示词');
  await expect(prompt(template)).toContainText('模板来源 · 生成文本');
  await expect(prompt(template)).toContainText('请根据');
  await expect(prompt(template)).toContainText('写剧本');
  await expect(reference.getByText('该输入来自工作流输入')).toBeVisible();
  await expect(asset.getByText('该输入来自资产')).toBeVisible();

  await connectPrompt(page, 'src-blank', 'blank');
  await expect(replaceDialog(page)).toHaveCount(0);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await expect(blank.getByText('该输入由连线提供')).toBeVisible();

  await connectPrompt(page, 'src-constant', 'constant');
  await expect(replaceDialog(page)).toBeVisible();
  await replaceDialog(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(replaceDialog(page)).toHaveCount(0);
  await expect(prompt(constant).getByRole('textbox')).toHaveValue('保持这段提示词');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  await connectPrompt(page, 'src-constant', 'constant');
  await replaceDialog(page).getByRole('button', { name: '确认替换', exact: true }).click();
  await expect(constant.getByText('该输入由连线提供')).toBeVisible();
  await expect(prompt(constant)).toHaveCount(0);
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);

  await connectPrompt(page, 'src-template', 'template');
  await expect(replaceDialog(page)).toBeVisible();
  await replaceDialog(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(prompt(template)).toContainText('模板来源 · 生成文本');
  await expect(prompt(template)).toContainText('写剧本');
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);

  await connectPrompt(page, 'src-template', 'template');
  await replaceDialog(page).getByRole('button', { name: '确认替换', exact: true }).click();
  await expect(template.getByText('该输入由连线提供')).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);

  await connectPrompt(page, 'src-reference', 'reference');
  await expect(replaceDialog(page)).toBeVisible();
  await replaceDialog(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(reference.getByText('该输入来自工作流输入')).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);

  await connectPrompt(page, 'src-asset', 'asset');
  await replaceDialog(page).getByRole('button', { name: '确认替换', exact: true }).click();
  await expect(asset.getByText('该输入由连线提供')).toBeVisible();
  await expect(asset.getByText('该输入来自资产')).toHaveCount(0);
  await expect(page.locator('.react-flow__edge')).toHaveCount(4);

  expect((await save(page)).ok()).toBeTruthy();
  const stored = await readWorkflow(request, project.id);
  const inputs = (id: string) => stored.draft.nodes.find((item) => item.id === id)?.inputs;
  expect(inputs('blank')).toEqual({});
  expect(inputs('constant')).toEqual({});
  expect(inputs('template')).toEqual({});
  expect(inputs('reference')).toEqual({ prompt: { type: 'workflow_input', key: 'topic' } });
  expect(inputs('asset')).toEqual({});
  expect(stored.draft.edges).toEqual([
    expect.objectContaining({
      kind: 'data',
      source: { nodeId: 'src-blank', portKey: 'text' },
      target: { nodeId: 'blank', portKey: 'prompt' },
    }),
    expect.objectContaining({
      kind: 'data',
      source: { nodeId: 'src-constant', portKey: 'text' },
      target: { nodeId: 'constant', portKey: 'prompt' },
    }),
    expect.objectContaining({
      kind: 'data',
      source: { nodeId: 'src-template', portKey: 'text' },
      target: { nodeId: 'template', portKey: 'prompt' },
    }),
    expect.objectContaining({
      kind: 'data',
      source: { nodeId: 'src-asset', portKey: 'text' },
      target: { nodeId: 'asset', portKey: 'prompt' },
    }),
  ]);

  await page.reload();
  await expect(blank.getByText('该输入由连线提供')).toBeVisible();
  await expect(constant.getByText('该输入由连线提供')).toBeVisible();
  await expect(template.getByText('该输入由连线提供')).toBeVisible();
  await expect(reference.getByText('该输入来自工作流输入')).toBeVisible();
  await expect(asset.getByText('该输入由连线提供')).toBeVisible();
  await expect(prompt(template)).toHaveCount(0);
  await expect(page.locator('.react-flow__edge')).toHaveCount(4);
});
