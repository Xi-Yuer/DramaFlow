import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page, Locator } from '@playwright/test';
import {
  projectSchema,
  modelProviderListSchema,
  modelConfigurationListSchema,
} from '@dramaflow/contracts';
import { test, expect, origin } from './fixtures.js';

async function project(api: APIRequestContext, name = '模型管理测试') {
  const response = await api.post('/api/v1/projects', {
    headers: { Origin: origin },
    data: { name },
  });
  expect(response.ok()).toBeTruthy();
  return projectSchema.parse(await response.json());
}
const drawer = (page: Page) => page.getByRole('dialog', { name: '模型设置', exact: true });
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true });
const suppliersTab = (page: Page) => drawer(page).getByRole('tab', { name: /模型供应商/ });
const modelsTab = (page: Page) => drawer(page).getByRole('tab', { name: /^模型（/ });
async function open(page: Page, id: string) {
  await page.goto(`/projects/${id}`);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await expect(drawer(page).getByRole('tab', { name: /^模型（/ })).toBeVisible();
}
async function choose(page: Page, select: Locator, option: string | RegExp) {
  await select.click();
  await page.getByRole('option', { name: option }).click();
}
async function fillSupplier(page: Page, name: string, secret: string, service = 'OpenAI') {
  const form = dialog(page, '添加模型供应商');
  await form.getByRole('textbox', { name: '供应商名称' }).fill(name);
  await choose(page, form.getByRole('combobox', { name: '模型服务' }), service);
  await expect(form.getByRole('textbox', { name: '服务地址', exact: true })).toHaveCount(0);
  await form.getByLabel('API Key', { exact: true }).fill(secret);
}
async function addSupplier(page: Page, name: string, secret: string, service = 'OpenAI') {
  await drawer(page).getByRole('button', { name: '添加供应商', exact: true }).click();
  await fillSupplier(page, name, secret, service);
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/providers/catalog'),
  );
  await dialog(page, '添加模型供应商')
    .getByRole('button', { name: '添加供应商', exact: true })
    .click();
  const created = await response;
  expect(created.status()).toBe(201);
  expect(await created.text()).not.toContain(secret);
  await expect(dialog(page, '添加模型')).toBeVisible();
}
async function addModel(page: Page, name: string, withSettings = true) {
  const form = dialog(page, '添加模型');
  await choose(page, form.getByRole('combobox', { name: '模型能力' }), /文本生成/);
  await form.getByRole('textbox', { name: '模型名称', exact: true }).fill(name);
  await form.getByRole('spinbutton', { name: '最大输出 Token 数' }).fill('64');
  if (withSettings) await form.getByRole('spinbutton', { name: '随机度（temperature）' }).fill('0');
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/model-configurations'),
  );
  await form.getByRole('button', { name: '添加模型', exact: true }).click();
  expect((await response).status()).toBe(201);
  await expect(dialog(page, '添加模型')).toHaveCount(0);
  await expect(
    drawer(page).getByRole('article', { name: `模型 ${name}`, exact: true }),
  ).toBeVisible();
}
async function readProviders(api: APIRequestContext, id: string) {
  return modelProviderListSchema.parse(
    await (await api.get(`/api/v1/projects/${id}/providers`)).json(),
  );
}
async function readModels(api: APIRequestContext, id: string) {
  return modelConfigurationListSchema.parse(
    await (await api.get(`/api/v1/projects/${id}/model-configurations`)).json(),
  );
}
async function cacheSnapshot(page: Page) {
  return page.evaluate(() => {
    type Cache = {
      getAll(): {
        queryKey?: unknown;
        state: { data?: unknown; variables?: unknown; error?: unknown };
      }[];
    };
    type Client = { getQueryCache(): Cache; getMutationCache(): Cache };
    type Fiber = { return: Fiber | null; memoizedProps?: { client?: Client } };
    const element = document.querySelector('.canvas-shell');
    if (!element) throw new Error('没有画布');
    const key = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    if (!key) throw new Error('没有 React 根');
    let fiber = (element as unknown as Record<string, unknown>)[key] as Fiber | null;
    while (fiber) {
      const client = fiber.memoizedProps?.client;
      if (
        client &&
        typeof client.getQueryCache === 'function' &&
        typeof client.getMutationCache === 'function'
      ) {
        return JSON.stringify({
          queries: client
            .getQueryCache()
            .getAll()
            .map((query) => ({
              key: query.queryKey,
              data: query.state.data,
              error: query.state.error,
            })),
          mutations: client
            .getMutationCache()
            .getAll()
            .map((mutation) => mutation.state),
        });
      }
      fiber = fiber.return;
    }
    throw new Error('没有找到 QueryClient');
  });
}
async function expectNoSecret(page: Page, secret: string) {
  expect(await page.locator('body').innerText()).not.toContain(secret);
  expect(await cacheSnapshot(page)).not.toContain(secret);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    ),
  ).not.toContain(secret);
  const inputs = await page
    .locator('input')
    .evaluateAll((elements) =>
      elements.map((element) => (element instanceof HTMLInputElement ? element.value : '')),
    );
  expect(inputs).not.toContain(secret);
}

test('项目到模型设置：创建供应商、配置凭证和文本模型，刷新恢复且 Secret 不回显 / 不进缓存', async ({
  page,
  request,
}) => {
  const p = await project(request),
    secret = `test-only-${randomUUID()}`;
  await open(page, p.id);
  await expect(drawer(page).getByText('先接入一个模型供应商', { exact: true })).toBeVisible();
  await drawer(page)
    .getByText(/可用模型服务（2）/, { exact: true })
    .click();
  await expect(drawer(page).getByRole('heading', { name: 'OpenAI', exact: true })).toBeVisible();
  await expect(drawer(page).getByRole('heading', { name: 'Anthropic', exact: true })).toBeVisible();
  await addSupplier(page, '自选兼容服务', secret, 'Anthropic');
  await expectNoSecret(page, secret);
  await addModel(page, 'custom-text-model');
  const card = drawer(page).getByRole('article', { name: '模型 custom-text-model', exact: true });
  await expect(card.getByText('可供工作流选择', { exact: true })).toBeVisible();
  expect((await readModels(request, p.id)).items[0]).toMatchObject({
    model: 'custom-text-model',
    settings: { temperature: 0, maxOutputTokens: 64 },
  });
  expect((await readProviders(request, p.id)).items[0]).toMatchObject({
    providerDefinitionId: 'anthropic',
    pluginId: 'text_generation',
    configuration: {
      provider: 'anthropic',
      baseURL: 'https://api.anthropic.com/v1',
      timeoutMs: 60000,
    },
  });
  await expectNoSecret(page, secret);
  await page.reload();
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await expect(
    drawer(page)
      .getByRole('article', { name: '模型 custom-text-model', exact: true })
      .getByText('可供工作流选择', { exact: true }),
  ).toBeVisible();
  await suppliersTab(page).click();
  await expect(drawer(page).getByText('Anthropic · 文本生成', { exact: true })).toBeVisible();
  await expect(drawer(page).getByText('https://api.anthropic.com/v1', { exact: true })).toHaveCount(
    0,
  );
  await drawer(page).getByRole('button', { name: '轮换凭证' }).click();
  await expect(dialog(page, '轮换访问凭证').getByLabel('API Key', { exact: true })).toHaveValue('');
  await expectNoSecret(page, secret);
});

test('同一供应商可添加多个模型，启停状态和不可选原因由服务端刷新', async ({ page, request }) => {
  const p = await project(request);
  await open(page, p.id);
  await addSupplier(page, '多模型服务', `test-only-${randomUUID()}`);
  await addModel(page, 'model-one');
  await suppliersTab(page).click();
  await drawer(page).getByRole('button', { name: '添加模型', exact: true }).click();
  await addModel(page, 'model-two', false);
  expect((await readModels(request, p.id)).items).toHaveLength(2);
  const card = drawer(page).getByRole('article', { name: '模型 model-two', exact: true });
  await card.getByRole('button', { name: '停用模型' }).click();
  await expect(card.getByText('模型已停用', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '启用模型' }).click();
  await expect(card.getByText('可供工作流选择', { exact: true })).toBeVisible();
  await suppliersTab(page).click();
  await drawer(page).getByRole('button', { name: '停用供应商' }).click();
  await expect(drawer(page).getByText('已停用', { exact: true })).toBeVisible();
  await modelsTab(page).click();
  await expect(drawer(page).getByText('供应商已停用', { exact: true })).toHaveCount(2);
  expect((await readModels(request, p.id)).items.every((model) => model.enabled)).toBe(true);
  await suppliersTab(page).click();
  await drawer(page).getByRole('button', { name: '启用供应商' }).click();
  await modelsTab(page).click();
  await expect(drawer(page).getByText('可供工作流选择', { exact: true })).toHaveCount(2);
});

test('凭证轮换明确且输入总为空；取消、成功和失败均不恢复旧 Secret', async ({ page, request }) => {
  const p = await project(request),
    secret = `test-only-${randomUUID()}`,
    next = `rotated-${randomUUID()}`;
  await open(page, p.id);
  await addSupplier(page, '轮换服务', secret);
  await dialog(page, '添加模型').getByRole('button', { name: '返回列表' }).click();
  await suppliersTab(page).click();
  const rotate = () => drawer(page).getByRole('button', { name: '轮换凭证' }).click();
  await rotate();
  await dialog(page, '轮换访问凭证').getByLabel('API Key', { exact: true }).fill(next);
  await dialog(page, '轮换访问凭证').getByRole('button', { name: '返回列表' }).click();
  await rotate();
  await expect(dialog(page, '轮换访问凭证').getByLabel('API Key', { exact: true })).toHaveValue('');
  await dialog(page, '轮换访问凭证').getByLabel('API Key', { exact: true }).fill(next);
  const response = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().endsWith('/credentials'),
  );
  await dialog(page, '轮换访问凭证').getByRole('button', { name: '确认轮换' }).click();
  expect((await response).status()).toBe(204);
  await expect(dialog(page, '轮换访问凭证')).toHaveCount(0);
  await rotate();
  await expect(dialog(page, '轮换访问凭证').getByLabel('API Key', { exact: true })).toHaveValue('');
  await page.route('**/api/v1/projects/*/providers/*/credentials', (route) =>
    route.fulfill({ status: 503, json: { message: next } }),
  );
  await dialog(page, '轮换访问凭证').getByLabel('API Key', { exact: true }).fill(next);
  await dialog(page, '轮换访问凭证').getByRole('button', { name: '确认轮换' }).click();
  await expect(
    dialog(page, '轮换访问凭证').getByText('凭证轮换未确认', { exact: true }),
  ).toBeVisible();
  await expect(dialog(page, '轮换访问凭证').getByLabel('API Key', { exact: true })).toHaveValue('');
  await expectNoSecret(page, next);
  await expectNoSecret(page, secret);
});

test('供应商创建失败保留非 Secret 表单，凭证清空且不进入错误缓存，可重新输入后成功', async ({
  page,
  request,
}) => {
  const p = await project(request),
    secret = `test-only-${randomUUID()}`;
  await open(page, p.id);
  await drawer(page).getByRole('button', { name: '添加供应商', exact: true }).click();
  await fillSupplier(page, '失败后重试', secret);
  await page.route('**/api/v1/projects/*/providers/catalog', async (route) => {
    if (route.request().method() === 'POST')
      await route.fulfill({
        status: 500,
        json: { message: secret, details: { credentials: secret } },
      });
    else await route.continue();
  });
  await dialog(page, '添加模型供应商')
    .getByRole('button', { name: '添加供应商', exact: true })
    .click();
  await expect(
    dialog(page, '添加模型供应商').getByText('供应商未确认保存', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog(page, '添加模型供应商').getByRole('textbox', { name: '供应商名称' }),
  ).toHaveValue('失败后重试');
  await expect(dialog(page, '添加模型供应商').getByLabel('API Key', { exact: true })).toHaveValue(
    '',
  );
  await expectNoSecret(page, secret);
  expect((await readProviders(request, p.id)).items).toHaveLength(0);
  await page.unroute('**/api/v1/projects/*/providers/catalog');
  await dialog(page, '添加模型供应商').getByLabel('API Key', { exact: true }).fill(secret);
  await dialog(page, '添加模型供应商')
    .getByRole('button', { name: '添加供应商', exact: true })
    .click();
  await expect(dialog(page, '添加模型')).toBeVisible();
});

test('模型创建及启停失败不误报成功；读取错误有明确重试', async ({ page, request }) => {
  const p = await project(request);
  await open(page, p.id);
  await addSupplier(page, '请求失败测试', `test-only-${randomUUID()}`);
  await choose(
    page,
    dialog(page, '添加模型').getByRole('combobox', { name: '模型能力' }),
    /文本生成/,
  );
  await dialog(page, '添加模型')
    .getByRole('textbox', { name: '模型名称', exact: true })
    .fill('recover-model');
  await dialog(page, '添加模型').getByRole('spinbutton', { name: '最大输出 Token 数' }).fill('64');
  await page.route('**/api/v1/projects/*/model-configurations', async (route) => {
    if (route.request().method() === 'POST') await route.abort('failed');
    else await route.continue();
  });
  await dialog(page, '添加模型').getByRole('button', { name: '添加模型', exact: true }).click();
  await expect(dialog(page, '添加模型').getByText('模型未确认保存', { exact: true })).toBeVisible();
  expect((await readModels(request, p.id)).items).toHaveLength(0);
  await page.unroute('**/api/v1/projects/*/model-configurations');
  await dialog(page, '添加模型').getByRole('button', { name: '添加模型', exact: true }).click();
  const card = drawer(page).getByRole('article', { name: '模型 recover-model', exact: true });
  await expect(card.getByText('可供工作流选择', { exact: true })).toBeVisible();
  await page.route('**/api/v1/projects/*/model-configurations/*', (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await card.getByRole('button', { name: '停用模型' }).click();
  await expect(drawer(page).getByText('操作未确认', { exact: true })).toBeVisible();
  await expect(card.getByText('可供工作流选择', { exact: true })).toBeVisible();
  await page.unroute('**/api/v1/projects/*/model-configurations/*');
  let pluginReads = 0;
  await page.route('**/api/v1/provider-plugins', async (route) => {
    pluginReads += 1;
    if (pluginReads === 1) await route.fulfill({ status: 500, json: {} });
    else await route.fallback();
  });
  await drawer(page).getByRole('button', { name: '刷新列表' }).click();
  await expect(drawer(page).getByText('模型设置读取失败', { exact: true })).toBeVisible();
  const retry = drawer(page).getByRole('button', { name: '重新读取模型设置' });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(card.getByText('可供工作流选择', { exact: true })).toBeVisible();
});

test('切换项目不复用另一项目配置；无权访问项目不能打开设置', async ({
  page,
  request,
  foreignId,
}) => {
  const a = await project(request, '供应商项目 A'),
    b = await project(request, '空白项目 B');
  await open(page, a.id);
  await addSupplier(page, '仅属于项目 A', `test-only-${randomUUID()}`);
  await addModel(page, 'project-a-model');
  await drawer(page).getByRole('button', { name: '关闭模型设置', exact: true }).click();
  await page.getByRole('button', { name: '返回项目', exact: true }).click();
  await page
    .getByRole('button')
    .filter({ has: page.getByText('空白项目 B', { exact: true }) })
    .click();
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await expect(drawer(page).getByText('先接入一个模型供应商', { exact: true })).toBeVisible();
  await expect(drawer(page).getByText('project-a-model', { exact: true })).toHaveCount(0);
  await expect(drawer(page).getByText('仅属于项目 A', { exact: true })).toHaveCount(0);
  expect((await readModels(request, b.id)).items).toHaveLength(0);
  await page.goto(`/projects/${foreignId}`);
  await expect(page.getByRole('button', { name: '重新连接' })).toBeVisible();
  await expect(page.getByRole('button', { name: '模型设置', exact: true })).toHaveCount(0);
});

test('窄屏可完成供应商和模型配置，页面不横向溢出', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const p = await project(request);
  await open(page, p.id);
  await addSupplier(page, '移动端供应商', `test-only-${randomUUID()}`);
  await addModel(page, 'mobile-model');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const rect = await drawer(page).boundingBox();
  expect(rect!.width).toBeLessThanOrEqual(390);
});

test('供应商保存请求期间凭证已清空，不进入 Query 缓存，也不能重复提交', async ({
  page,
  request,
}) => {
  const p = await project(request),
    secret = `in-flight-${randomUUID()}`;
  await open(page, p.id);
  await drawer(page).getByRole('button', { name: '添加供应商', exact: true }).click();
  await fillSupplier(page, '提交中的供应商', secret);
  let release!: () => void, received!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    received = resolve;
  });
  let writes = 0;
  await page.route('**/api/v1/projects/*/providers/catalog', async (route) => {
    if (route.request().method() === 'POST') {
      writes++;
      received();
      await gate;
    }
    await route.continue();
  });
  await dialog(page, '添加模型供应商')
    .getByRole('button', { name: '添加供应商', exact: true })
    .click();
  await waiting;
  try {
    await expect(dialog(page, '添加模型供应商').getByLabel('API Key', { exact: true })).toHaveValue(
      '',
    );
    await expect(
      dialog(page, '添加模型供应商').getByRole('button', { name: '添加供应商', exact: true }),
    ).toBeDisabled();
    await expectNoSecret(page, secret);
    expect(writes).toBe(1);
  } finally {
    release();
  }
  await expect(dialog(page, '添加模型')).toBeVisible();
  expect((await readProviders(request, p.id)).items).toHaveLength(1);
});

test('空目录阻止普通创建；无法呈现的自定义 Schema 不发送部分配置', async ({ page, request }) => {
  const p = await project(request);
  const plugins = (await (await request.get('/api/v1/provider-plugins')).json()) as {
    items: Record<string, unknown>[];
  };
  await page.route('**/api/v1/provider-catalog', (route) => route.fulfill({ json: { items: [] } }));
  await open(page, p.id);
  await expect(
    drawer(page).getByRole('button', { name: '添加供应商', exact: true }),
  ).toBeDisabled();
  await expect(drawer(page).getByRole('button', { name: '自定义接入', exact: true })).toBeEnabled();
  await page.unroute('**/api/v1/provider-catalog');
  await page.route('**/api/v1/provider-plugins', (route) =>
    route.fulfill({
      json: {
        items: plugins.items.map((plugin) => ({
          ...plugin,
          configurationSchema: {
            type: 'object',
            properties: { nested: { type: 'array', items: { type: 'string' } } },
            additionalProperties: false,
          },
        })),
      },
    }),
  );
  await drawer(page).getByRole('button', { name: '刷新列表' }).click();
  await drawer(page).getByRole('button', { name: '自定义接入', exact: true }).click();
  await choose(
    page,
    dialog(page, '自定义接入').getByRole('combobox', { name: '接入方式' }),
    /OpenAI 兼容协议/,
  );
  await expect(
    dialog(page, '自定义接入').getByText('此接入方式的表单格式暂不受支持，请联系部署管理员', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog(page, '自定义接入').getByRole('button', { name: '添加供应商', exact: true }),
  ).toBeDisabled();
  expect((await readProviders(request, p.id)).items).toHaveLength(0);
});

test('自定义接入仍可配置兼容地址，刷新后保留', async ({ page, request }) => {
  const p = await project(request),
    secret = `custom-${randomUUID()}`;
  await open(page, p.id);
  await drawer(page).getByRole('button', { name: '自定义接入', exact: true }).click();
  const form = dialog(page, '自定义接入');
  await form.getByRole('textbox', { name: '供应商名称' }).fill('自建兼容服务');
  await choose(page, form.getByRole('combobox', { name: '接入方式' }), /OpenAI 兼容协议/);
  await form
    .getByRole('textbox', { name: '服务地址', exact: true })
    .fill('http://127.0.0.1:1/custom/v1');
  await form.getByLabel('API Key', { exact: true }).fill(secret);
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/providers'),
  );
  await form.getByRole('button', { name: '添加供应商', exact: true }).click();
  const created = await response;
  expect(created.status()).toBe(201);
  expect(created.url()).not.toContain('/catalog');
  expect(await created.text()).not.toContain(secret);
  await dialog(page, '添加模型').getByRole('button', { name: '返回列表' }).click();
  await suppliersTab(page).click();
  await expect(
    drawer(page).getByText('http://127.0.0.1:1/custom/v1', { exact: true }),
  ).toBeVisible();
  expect((await readProviders(request, p.id)).items[0]).toMatchObject({
    providerDefinitionId: null,
    pluginId: 'openai_compatible',
    configuration: { baseURL: 'http://127.0.0.1:1/custom/v1', timeoutMs: 60000 },
  });
  await page.reload();
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await suppliersTab(page).click();
  await expect(
    drawer(page).getByText('http://127.0.0.1:1/custom/v1', { exact: true }),
  ).toBeVisible();
  await expectNoSecret(page, secret);
});

test('模型设置保留画布内未保存的项目信息，管理操作不推进图和项目 revision', async ({
  page,
  request,
}) => {
  const p = await project(request);
  await page.goto(`/projects/${p.id}`);
  await page.getByRole('textbox', { name: '项目名称' }).fill('未保存的项目名称');
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await expect(modelsTab(page)).toBeVisible();
  await addSupplier(page, '独立模型配置', `test-only-${randomUUID()}`);
  await addModel(page, 'independent-model');
  await drawer(page).getByRole('button', { name: '关闭模型设置' }).click();
  await expect(page.getByRole('textbox', { name: '项目名称' })).toHaveValue('未保存的项目名称');
  await expect(page.getByRole('status', { name: '项目信息状态' })).toHaveText('项目信息未保存');
  expect(
    projectSchema.parse(await (await request.get(`/api/v1/projects/${p.id}`)).json()).revision,
  ).toBe(p.revision);
  await expect(page.getByRole('status', { name: '工作流草稿状态' })).toHaveText(
    '草稿已保存 · 修订 1',
  );
});
