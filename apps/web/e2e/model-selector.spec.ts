import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  managedModelConfigurationSchema,
  modelConfigurationListSchema,
  modelProviderSchema,
  projectSchema,
  workflowResponseSchema,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { expect, origin, test } from './fixtures.js';

function definition(): WorkflowDefinition {
  return {
    inputs: [],
    nodes: [
      {
        id: 'a',
        type: 'ai.text_generate',
        typeVersion: 1,
        name: '剧本',
        inputs: {},
        config: {},
        ui: { position: { x: 120, y: 120 } },
      },
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
        data: { name: '模型选择测试' },
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

async function createProvider(api: APIRequestContext, projectId: string, providerDefinitionId: string) {
  const response = await api.post(`/api/v1/projects/${projectId}/providers/catalog`, {
    headers: { Origin: origin },
    data: {
      name: providerDefinitionId === 'openai' ? 'OpenAI' : 'Anthropic',
      providerDefinitionId,
      credentials: { apiKey: `test-only-${randomUUID()}` },
    },
  });
  expect(response.ok()).toBeTruthy();
  return modelProviderSchema.parse(await response.json());
}

async function createTextModel(api: APIRequestContext, projectId: string, providerId: string, model: string) {
  const response = await api.post(`/api/v1/projects/${projectId}/model-configurations`, {
    headers: { Origin: origin },
    data: {
      providerId,
      capability: 'text.generate',
      model,
      settings: { maxOutputTokens: 128 },
    },
  });
  expect(response.ok()).toBeTruthy();
  return managedModelConfigurationSchema.parse(await response.json());
}

async function readWorkflow(api: APIRequestContext, projectId: string) {
  return workflowResponseSchema.parse(
    await (await api.get(`/api/v1/projects/${projectId}/workflow`)).json(),
  );
}

const selector = (page: Page) => page.getByRole('dialog', { name: '选择模型', exact: true });

test('文本节点只列出 text.generate 模型，选择后保存并在刷新后恢复', async ({ page, request }) => {
  const project = await createProject(request);
  const provider = await createProvider(request, project.id, 'openai');
  const model = await createTextModel(request, project.id, provider.id, 'gpt-4o');
  const catalogUrls: string[] = [];
  page.on('request', (incoming) => {
    if (incoming.url().includes('/model-catalog')) catalogUrls.push(incoming.url());
  });
  await page.goto(`/projects/${project.id}`);
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  const panel = selector(page);
  await expect(panel.getByRole('group', { name: 'OpenAI' }).getByRole('option', { name: 'GPT-4o' })).toBeVisible();
  await expect(panel.getByRole('group', { name: 'Anthropic' }).getByText('Claude Sonnet 4', { exact: true })).toBeVisible();
  await expect(panel.getByText('未配置', { exact: true })).toBeVisible();
  await expect(panel.getByRole('option')).toHaveCount(1);
  expect(catalogUrls.length).toBeGreaterThan(0);
  expect(catalogUrls.every((url) => url.includes('capability=text.generate'))).toBe(true);
  await expect(panel).not.toContainText('text_generation');
  await expect(panel).not.toContainText('baseURL');
  await expect(panel).not.toContainText('pluginId');

  await panel.getByRole('textbox', { name: '搜索模型', exact: true }).fill('claude');
  await expect(panel.getByText('GPT-4o')).toHaveCount(0);
  await expect(panel.getByText('Claude Sonnet 4', { exact: true })).toBeVisible();
  await panel.getByRole('textbox', { name: '搜索模型', exact: true }).fill('没有这个模型');
  await expect(panel.getByRole('status')).toHaveText('没有匹配的模型');
  await panel.getByRole('textbox', { name: '搜索模型', exact: true }).fill('');
  await panel.getByRole('button', { name: '配置 Anthropic', exact: true }).click();
  const setup = page.getByRole('dialog', { name: '配置 Anthropic', exact: true });
  await expect(setup).toBeVisible();
  await setup.getByRole('button', { name: '返回列表', exact: true }).click();
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();

  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await selector(page).getByRole('option', { name: 'GPT-4o' }).click();
  await expect(page.getByRole('button', { name: '已选 GPT-4o', exact: true })).toBeVisible();
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.url().endsWith('/draft'),
  );
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  const payload: unknown = (await saved).request().postDataJSON();
  expect(payload).toMatchObject({
    definition: { nodes: [{ config: { modelConfigurationId: model.id } }] },
  });
  await page.reload();
  await expect(page.getByRole('button', { name: '已选 GPT-4o', exact: true })).toBeVisible();
  expect((await readWorkflow(request, project.id)).draft.nodes[0]?.config).toEqual({
    modelConfigurationId: model.id,
  });
});

test('供应商已配置但目录模型尚无配置时，用现有创建接口补上并只写入 configuration id', async ({
  page,
  request,
}) => {
  const project = await createProject(request);
  await createProvider(request, project.id, 'openai');
  await page.goto(`/projects/${project.id}`);
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await selector(page).getByRole('button', { name: '添加 GPT-4o', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加 GPT-4o', exact: true });
  await dialog.getByRole('spinbutton', { name: '最大输出 Token 数' }).fill('256');
  await dialog.getByRole('button', { name: '添加并选择', exact: true }).click();
  await expect(page.getByRole('button', { name: '已选 GPT-4o', exact: true })).toBeVisible();
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.url().endsWith('/draft'),
  );
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await saved;
  const workflow = await readWorkflow(request, project.id);
  const configurationId = workflow.draft.nodes[0]?.config.modelConfigurationId;
  expect(workflow.draft.nodes[0]?.config).toEqual({ modelConfigurationId: configurationId });
  const models = modelConfigurationListSchema.parse(
    await (await request.get(`/api/v1/projects/${project.id}/model-configurations`)).json(),
  );
  expect(models.items).toEqual([
    expect.objectContaining({
      id: configurationId,
      capability: 'text.generate',
      model: 'gpt-4o',
      settings: { maxOutputTokens: 256 },
    }),
  ]);
  await page.reload();
  await expect(page.getByRole('button', { name: '已选 GPT-4o', exact: true })).toBeVisible();
});
