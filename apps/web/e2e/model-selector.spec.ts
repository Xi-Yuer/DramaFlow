import { createProjectWithWorkflow } from './fixtures.js';
import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  managedModelConfigurationSchema,
  modelConfigurationListSchema,
  modelProviderSchema,
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
  const project = await createProjectWithWorkflow(api, '画布测试项目');
  const workflow = workflowResponseSchema.parse(
    await (await api.get(`/api/v1/projects/${project.id}/workflows/${project.workflowId}`)).json(),
  );
  const saved = await api.put(`/api/v1/workflows/${workflow.id}/draft`, {
    headers: { Origin: origin },
    data: { expectedRevision: workflow.revision, definition: definition() },
  });
  expect(saved.ok()).toBeTruthy();
  return project;
}

async function createProvider(api: APIRequestContext, providerDefinitionId: string) {
  const response = await api.post(`/api/v1/providers/catalog`, {
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

async function createTextModel(api: APIRequestContext, providerId: string, model: string) {
  const response = await api.post(`/api/v1/model-configurations`, {
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

async function readWorkflow(api: APIRequestContext, projectId: string, workflowId: string) {
  return workflowResponseSchema.parse(
    await (await api.get(`/api/v1/projects/${projectId}/workflows/${workflowId}`)).json(),
  );
}

const selector = (page: Page) => page.getByRole('dialog', { name: '选择模型', exact: true });

test('文本节点只列出 text.generate 模型，选择后保存并在刷新后恢复', async ({ page, request }) => {
  const project = await createProject(request);
  const provider = await createProvider(request, 'openai');
  const model = await createTextModel(request, provider.id, 'gpt-4o');
  const catalogUrls: string[] = [];
  page.on('request', (incoming) => {
    if (incoming.url().includes('/model-catalog')) catalogUrls.push(incoming.url());
  });
  await page.goto(`/projects/${project.id}/workflows/${project.workflowId}`);
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  const panel = selector(page);
  await expect(
    panel.getByRole('group', { name: 'OpenAI' }).getByRole('option', { name: 'GPT-4o' }),
  ).toBeVisible();
  await expect(
    panel.getByRole('group', { name: 'Anthropic' }).getByText('Claude Sonnet 4', { exact: true }),
  ).toBeVisible();
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
  await expect(
    page.getByRole('button', { name: '已选 GPT-4o，最大输出 128', exact: true }),
  ).toBeVisible();
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.url().endsWith('/draft'),
  );
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  const payload: unknown = (await saved).request().postDataJSON();
  expect(payload).toMatchObject({
    definition: { nodes: [{ config: { modelConfigurationId: model.id } }] },
  });
  await page.reload();
  await expect(
    page.getByRole('button', { name: '已选 GPT-4o，最大输出 128', exact: true }),
  ).toBeVisible();
  expect(
    (await readWorkflow(request, project.id, project.workflowId)).draft.nodes[0]?.config,
  ).toEqual({
    modelConfigurationId: model.id,
  });
});

test('供应商已配置但目录模型尚无配置时，用现有创建接口补上并只写入 configuration id', async ({
  page,
  request,
}) => {
  const project = await createProject(request);
  await createProvider(request, 'openai');
  await page.goto(`/projects/${project.id}/workflows/${project.workflowId}`);
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await selector(page).getByRole('button', { name: '添加 GPT-4o', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加 GPT-4o', exact: true });
  await dialog.getByRole('spinbutton', { name: '最大输出 Token 数' }).fill('256');
  await dialog.getByRole('button', { name: '添加并选择', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '已选 GPT-4o，最大输出 256', exact: true }),
  ).toBeVisible();
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.url().endsWith('/draft'),
  );
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await saved;
  const workflow = await readWorkflow(request, project.id, project.workflowId);
  const configurationId = workflow.draft.nodes[0]?.config.modelConfigurationId;
  expect(workflow.draft.nodes[0]?.config).toEqual({ modelConfigurationId: configurationId });
  const models = modelConfigurationListSchema.parse(
    await (await request.get(`/api/v1/model-configurations`)).json(),
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
  await expect(
    page.getByRole('button', { name: '已选 GPT-4o，最大输出 256', exact: true }),
  ).toBeVisible();
});

async function saveDraft(page: Page) {
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.url().endsWith('/draft'),
  );
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  expect((await saved).ok()).toBeTruthy();
}

async function configureProvider(page: Page, name: string) {
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await selector(page)
    .getByRole('button', { name: `配置 ${name}`, exact: true })
    .click();
  const setup = page.getByRole('dialog', { name: `配置 ${name}`, exact: true });
  await setup.getByLabel('API Key', { exact: true }).fill(`test-only-${randomUUID()}`);
  const response = page.waitForResponse(
    (item) => item.request().method() === 'POST' && item.url().endsWith('/providers/catalog'),
  );
  await setup.getByRole('button', { name: '保存 API Key', exact: true }).click();
  expect((await response).ok()).toBeTruthy();
}

test('未配置供应商时从目录模型配置，添加后自动选择并在刷新后恢复', async ({ page, request }) => {
  const project = await createProject(request);
  await page.goto(`/projects/${project.id}/workflows/${project.workflowId}`);
  await configureProvider(page, 'Anthropic');
  const dialog = page.getByRole('dialog', { name: '添加 Claude Sonnet 4', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('spinbutton', { name: '最大输出 Token 数' }).fill('256');
  await dialog.getByRole('spinbutton', { name: '随机度（temperature）' }).fill('0.3');
  await dialog.getByRole('button', { name: '添加并选择', exact: true }).click();
  const selected = page.getByRole('button', {
    name: '已选 Claude Sonnet 4，最大输出 256 · 随机度 0.3',
    exact: true,
  });
  await expect(selected).toBeVisible();
  await expect(selected).toContainText('最大输出 256 · 随机度 0.3');
  await saveDraft(page);
  const workflow = await readWorkflow(request, project.id, project.workflowId);
  const configurationId = workflow.draft.nodes[0]?.config.modelConfigurationId;
  expect(workflow.draft.nodes[0]?.config).toEqual({ modelConfigurationId: configurationId });
  const models = modelConfigurationListSchema.parse(
    await (await request.get(`/api/v1/model-configurations`)).json(),
  );
  expect(models.items).toEqual([
    expect.objectContaining({
      id: configurationId,
      model: 'claude-sonnet-4-20250514',
      settings: expect.objectContaining({ maxOutputTokens: 256, temperature: 0.3 }),
    }),
  ]);
  await page.reload();
  await expect(selected).toBeVisible();
});

test('供应商配置完成时目录模型已有可用配置，直接选中且不再进入添加', async ({ page, request }) => {
  const project = await createProject(request);
  await page.route('**/providers/catalog', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const provider = modelProviderSchema.parse(await response.json());
    const created = await request.post(`/api/v1/model-configurations`, {
      headers: { Origin: origin },
      data: {
        providerId: provider.id,
        capability: 'text.generate',
        model: 'claude-sonnet-4-20250514',
        settings: { maxOutputTokens: 64, temperature: 0.4 },
      },
    });
    expect(created.ok()).toBeTruthy();
    await route.fulfill({ status: response.status(), json: provider });
  });
  await page.goto(`/projects/${project.id}/workflows/${project.workflowId}`);
  await configureProvider(page, 'Anthropic');
  await expect(page.getByRole('dialog', { name: '添加 Claude Sonnet 4', exact: true })).toHaveCount(
    0,
  );
  const selected = page.getByRole('button', {
    name: '已选 Claude Sonnet 4，最大输出 64 · 随机度 0.4',
    exact: true,
  });
  await expect(selected).toBeVisible();
  await expect(selected).toContainText('随机度 0.4');
  await saveDraft(page);
  await page.reload();
  await expect(selected).toBeVisible();
  expect(
    (await readWorkflow(request, project.id, project.workflowId)).draft.nodes[0]?.config,
  ).toEqual({
    modelConfigurationId: expect.any(String),
  });
});

test('取消供应商配置或取消添加模型后，节点保持未选择', async ({ page, request }) => {
  const project = await createProject(request);
  await page.goto(`/projects/${project.id}/workflows/${project.workflowId}`);
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await selector(page).getByRole('button', { name: '配置 Anthropic', exact: true }).click();
  await page
    .getByRole('dialog', { name: '配置 Anthropic', exact: true })
    .getByRole('button', { name: '返回列表', exact: true })
    .click();
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '添加 Claude Sonnet 4', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toBeVisible();
  await expect(page.getByRole('status', { name: '工作流草稿状态' })).not.toContainText('未保存');

  await configureProvider(page, 'Anthropic');
  const dialog = page.getByRole('dialog', { name: '添加 Claude Sonnet 4', exact: true });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toBeVisible();
  await expect(page.getByRole('status', { name: '工作流草稿状态' })).not.toContainText('未保存');
  expect(
    (await readWorkflow(request, project.id, project.workflowId)).draft.nodes[0]?.config,
  ).toEqual({});
});

test('从设置页配置供应商不会继续节点上的模型选择', async ({ page, request }) => {
  const project = await createProject(request);
  await page.goto(`/projects/${project.id}/workflows/${project.workflowId}`);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '模型设置', exact: true });
  await drawer.getByRole('tab', { name: /模型供应商/ }).click();
  await drawer
    .getByRole('article', { name: '供应商 OpenAI', exact: true })
    .getByRole('button', { name: '配置 API Key', exact: true })
    .click();
  const form = page.getByRole('dialog', { name: '配置 OpenAI', exact: true });
  await form.getByLabel('API Key', { exact: true }).fill(`test-only-${randomUUID()}`);
  await form.getByRole('button', { name: '保存 API Key', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(
    drawer
      .getByRole('article', { name: '供应商 OpenAI', exact: true })
      .getByText('已配置', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog', { name: '添加 GPT-4o', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toBeVisible();
  expect(
    (await readWorkflow(request, project.id, project.workflowId)).draft.nodes[0]?.config,
  ).toEqual({});
});
