import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  workflowResponseSchema,
  projectSchema,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { test, expect, origin } from './fixtures.js';

function definition(): WorkflowDefinition {
  return {
    inputs: [{ name: 'topic', type: { kind: 'primitive', name: 'string' }, required: true }],
    nodes: [
      {
        id: 'a',
        type: 'ai.text_generate',
        typeVersion: 1,
        name: '剧本',
        preset: 'script',
        inputs: {
          prompt: { type: 'workflow_input', key: 'topic' },
          system: { type: 'constant', value: '写作' },
        },
        config: {},
        ui: { position: { x: 100, y: 100 } },
      },
      {
        id: 'b',
        type: 'ai.text_generate',
        typeVersion: 1,
        name: '润色',
        inputs: {},
        config: {},
        ui: { position: { x: 600, y: 100 } },
      },
    ],
    edges: [
      {
        id: 'text-edge',
        kind: 'data',
        source: { nodeId: 'a', portKey: 'text' },
        target: { nodeId: 'b', portKey: 'prompt' },
      },
    ],
    outputs: [
      {
        name: 'result',
        type: { kind: 'primitive', name: 'string' },
        source: { nodeId: 'b', outputKey: 'text' },
      },
    ],
  };
}
async function createProject(api: APIRequestContext, graph?: WorkflowDefinition) {
  const project = projectSchema.parse(
    await (
      await api.post('/api/v1/projects', {
        headers: { Origin: origin },
        data: { name: '持久化测试' },
      })
    ).json(),
  );
  let workflow = await readWorkflow(api, project.id);
  if (graph) {
    const result = await api.put(`/api/v1/workflows/${workflow.id}/draft`, {
      headers: { Origin: origin },
      data: { expectedRevision: workflow.revision, definition: graph },
    });
    expect(result.ok()).toBeTruthy();
    workflow = await readWorkflow(api, project.id);
  }
  return { project, workflow };
}
async function readWorkflow(api: APIRequestContext, projectId: string) {
  return workflowResponseSchema.parse(
    await (await api.get(`/api/v1/projects/${projectId}/workflow`)).json(),
  );
}
const node = (page: Page) => page.locator('.react-flow__node[data-id="a"]');
const status = (page: Page) => page.getByRole('status', { name: '工作流草稿状态' });
async function move(page: Page, dx = 80, dy = 60) {
  const header = node(page).locator('header');
  await expect(header).toBeVisible();
  const box = (await header.boundingBox())!;
  await page.mouse.move(box.x + 50, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + 50 + dx, box.y + 15 + dy, { steps: 10 });
  await page.mouse.up();
}
async function save(page: Page) {
  const response = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().endsWith('/draft'),
  );
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  return response;
}

test('用户新建项目直接加载真实空草稿，不触发初始化 POST', async ({ page, request }) => {
  const initialized: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/workflow')) initialized.push(r.url());
  });
  await page.goto('/projects');
  await page.getByRole('button', { name: '新建项目', exact: true }).first().click();
  await page.getByRole('textbox', { name: '项目名称', exact: true }).fill('用户创建的新项目');
  const created = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/v1/projects'),
  );
  await page.getByRole('button', { name: /创\s*建/, exact: true }).click();
  const project = projectSchema.parse(await (await created).json());
  await expect(status(page)).toHaveText('草稿已保存 · 修订 1');
  const workflow = await readWorkflow(request, project.id);
  expect(workflow.draft).toEqual({ inputs: [], nodes: [], edges: [], outputs: [] });
  await expect(page.getByText('当前草稿还没有节点。节点添加与配置尚未开放。')).toBeVisible();
  expect(initialized).toEqual([]);
});

test('旧项目必须明确初始化；失败可重试，重复初始化返回同一 Workflow', async ({ page, request }) => {
  const projectId = process.env.WEB_TEST_LEGACY_PROJECT_ID!;
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('button', { name: '初始化工作流', exact: true })).toBeVisible();
  expect((await request.get(`/api/v1/projects/${projectId}/workflow`)).status()).toBe(404);
  await page.route('**/api/v1/projects/*/workflow', async (route) => {
    if (route.request().method() === 'POST')
      await route.fulfill({ status: 500, json: { message: '初始化暂时失败' } });
    else await route.continue();
  });
  await page.getByRole('button', { name: '初始化工作流', exact: true }).click();
  await expect(page.getByText('工作流初始化失败', { exact: true })).toBeVisible();
  await page.unroute('**/api/v1/projects/*/workflow');
  await page.getByRole('button', { name: '初始化工作流', exact: true }).click();
  await expect(status(page)).toHaveText('草稿已保存 · 修订 1');
  const workflow = await readWorkflow(request, projectId);
  const repeated = workflowResponseSchema.parse(
    await (
      await request.post(`/api/v1/projects/${projectId}/workflow`, {
        headers: { Origin: origin },
        data: {},
      })
    ).json(),
  );
  expect(repeated.id).toBe(workflow.id);
});

test('真实 HTTP 草稿显示、移动、保存、刷新往返完整领域数据，Project revision 独立', async ({
  page,
  request,
}) => {
  const graph = definition();
  const { project, workflow } = await createProject(request, graph);
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByText('润色', { exact: true })).toBeVisible();
  await expect(node(page).locator('article')).not.toHaveAttribute('class', /undefined/);
  expect(await node(page).evaluate((element) => element.getBoundingClientRect().width)).toBe(300);
  await move(page);
  await expect(status(page)).toHaveText('草稿未保存');
  const response = await save(page);
  expect(response.ok()).toBeTruthy();
  const submitted = response.request().postDataJSON();
  expect(submitted.expectedRevision).toBe(workflow.revision);
  const expected = structuredClone(graph);
  expected.nodes[0].ui.position = submitted.definition.nodes[0].ui.position;
  expect(submitted.definition).toEqual(expected);
  expect(expected.nodes[0].ui.position).not.toEqual(graph.nodes[0].ui.position);
  await expect(status(page)).toHaveText(`草稿已保存 · 修订 ${workflow.revision + 1}`);
  expect((await readWorkflow(request, project.id)).draft).toEqual(expected);
  expect(
    projectSchema.parse(await (await request.get(`/api/v1/projects/${project.id}`)).json())
      .revision,
  ).toBe(project.revision);
  await page.reload();
  await expect(status(page)).toHaveText(`草稿已保存 · 修订 ${workflow.revision + 1}`);
  await expect(node(page)).toHaveAttribute(
    'style',
    new RegExp(
      `translate\\(${expected.nodes[0].ui.position.x}px, ${expected.nodes[0].ui.position.y}px\\)`,
    ),
  );
  // 保存项目名称只推进 Project revision，不改变图或 Workflow revision。
  await page.getByRole('textbox', { name: '项目名称' }).fill('独立项目信息');
  await page.getByRole('button', { name: '保存项目信息', exact: true }).click();
  await expect(page.getByRole('status', { name: '项目信息状态' })).toHaveText(
    `项目已保存 · 修订 ${project.revision + 1}`,
  );
  expect((await readWorkflow(request, project.id)).revision).toBe(workflow.revision + 1);
});

test('删除数据连线可保存并刷新，其他领域字段不丢失', async ({ page, request }) => {
  const { project } = await createProject(request, definition());
  await page.goto(`/projects/${project.id}`);
  const edge = page.locator('.react-flow__edge[data-id="text-edge"]');
  await expect(edge).toBeVisible();
  await edge.click();
  await page.keyboard.press('Backspace');
  await expect(edge).toHaveCount(0);
  expect((await save(page)).ok()).toBeTruthy();
  const stored = await readWorkflow(request, project.id);
  expect(stored.draft).toEqual({ ...definition(), edges: [] });
  await expect(status(page)).toContainText('草稿已保存');
  await page.reload();
  await expect(node(page)).toBeVisible();
  await expect(edge).toHaveCount(0);
});

test('409 保留本地图并阻止覆盖；取消读取不丢修改，确认读取保留项目名称', async ({
  page,
  request,
}) => {
  const { project, workflow } = await createProject(request, definition());
  await page.goto(`/projects/${project.id}`);
  await move(page);
  await page.getByRole('textbox', { name: '项目名称' }).fill('本地名称');
  const server = definition();
  server.nodes[0].ui.position.x = 350;
  expect(
    (
      await request.put(`/api/v1/workflows/${workflow.id}/draft`, {
        headers: { Origin: origin },
        data: { expectedRevision: workflow.revision, definition: server },
      })
    ).ok(),
  ).toBeTruthy();
  expect((await save(page)).status()).toBe(409);
  await expect(status(page)).toHaveText('草稿修订冲突');
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  const localPosition = await node(page).getAttribute('style');
  await page.getByRole('button', { name: '重新读取草稿' }).click();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(node(page)).toHaveAttribute('style', localPosition!);
  expect((await readWorkflow(request, project.id)).draft).toEqual(server);
  await page.getByRole('button', { name: '重新读取草稿' }).click();
  await page.getByRole('button', { name: '读取服务器草稿', exact: true }).click();
  await expect(status(page)).toHaveText(`草稿已保存 · 修订 ${workflow.revision + 1}`);
  await expect(page.getByRole('textbox', { name: '项目名称' })).toHaveValue('本地名称');
  await expect(node(page)).toHaveAttribute('style', /translate\(350px, 100px\)/);
});

test('服务端或网络保存失败保持未确认和原修订，重试可以成功', async ({ page, request }) => {
  const { project, workflow } = await createProject(request, definition());
  await page.goto(`/projects/${project.id}`);
  await move(page);
  await page.route('**/api/v1/workflows/*/draft', (route) =>
    route.fulfill({ status: 500, json: { message: '服务暂时不可用' } }),
  );
  expect((await save(page)).status()).toBe(500);
  await expect(status(page)).toHaveText('草稿操作未完成');
  expect((await readWorkflow(request, project.id)).revision).toBe(workflow.revision);
  await page.unroute('**/api/v1/workflows/*/draft');
  await page.route('**/api/v1/workflows/*/draft', (route) => route.abort('failed'));
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(
    page.getByText('草稿保存结果未确认，请检查网络后重试', { exact: true }),
  ).toBeVisible();
  await expect(status(page)).toHaveText('草稿操作未完成');
  await page.unroute('**/api/v1/workflows/*/draft');
  const response = await save(page);
  expect(response.request().postDataJSON().expectedRevision).toBe(workflow.revision);
  await expect(status(page)).toHaveText(`草稿已保存 · 修订 ${workflow.revision + 1}`);
});

test('保存期间继续移动不会误报已全部保存，后一次保存使用新 revision', async ({ page, request }) => {
  const { project, workflow } = await createProject(request, definition());
  await page.goto(`/projects/${project.id}`);
  await move(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received!: () => void;
  const waiting = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route('**/api/v1/workflows/*/draft', async (route) => {
    received();
    await gate;
    await route.continue();
  });
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await waiting;
  await move(page, 60, 30);
  release();
  await expect(status(page)).toHaveText('草稿未保存');
  await page.unroute('**/api/v1/workflows/*/draft');
  const response = await save(page);
  expect(response.request().postDataJSON().expectedRevision).toBe(workflow.revision + 1);
  await expect(status(page)).toHaveText(`草稿已保存 · 修订 ${workflow.revision + 2}`);
});

test('Workflow 读取失败没有本地空定义兜底，可明确重试', async ({ page, request }) => {
  const { project } = await createProject(request, definition());
  await page.route('**/api/v1/projects/*/workflow', (route) =>
    route.fulfill({ status: 500, json: { message: '读取失败' } }),
  );
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByText('工作流读取失败', { exact: true })).toBeVisible();
  await expect(page.locator('.react-flow')).toHaveCount(0);
  await page.unroute('**/api/v1/projects/*/workflow');
  await page.getByRole('button', { name: '重新读取工作流' }).click();
  await expect(node(page)).toBeVisible();
});

test('越权和不存在项目不能进入画布或初始化 Workflow', async ({ page, foreignId }) => {
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/workflow')) writes.push(r.url());
  });
  for (const id of [foreignId, randomUUID()]) {
    await page.goto(`/projects/${id}`);
    await expect(page.getByRole('button', { name: '重新连接' })).toBeVisible();
    await expect(page.locator('.react-flow')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '初始化工作流', exact: true })).toHaveCount(0);
  }
  expect(writes).toEqual([]);
});

test('Project 冲突重新读取只替换元数据，保留未保存的图', async ({ page, request }) => {
  const { project, workflow } = await createProject(request, definition());
  await page.goto(`/projects/${project.id}`);
  await move(page);
  const localPosition = await node(page).getAttribute('style');
  await page.getByRole('textbox', { name: '项目名称' }).fill('本地名称');
  expect(
    (
      await request.put(`/api/v1/projects/${project.id}`, {
        headers: { Origin: origin },
        data: { revision: project.revision, name: '服务器名称', viewport: project.viewport },
      })
    ).ok(),
  ).toBeTruthy();
  await page.getByRole('button', { name: '保存项目信息', exact: true }).click();
  await expect(page.getByRole('status', { name: '项目信息状态' })).toHaveText('项目信息冲突');
  await page.getByRole('button', { name: '重新读取项目信息' }).click();
  await page.getByRole('button', { name: '读取服务器项目信息', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '项目名称' })).toHaveValue('服务器名称');
  await expect(node(page)).toHaveAttribute('style', localPosition!);
  await expect(status(page)).toHaveText('草稿未保存');
  const response = await save(page);
  expect(response.request().postDataJSON().expectedRevision).toBe(workflow.revision);
});

test('窄屏仍显示两个独立保存状态和操作，不产生页面横向溢出', async ({ page, request }) => {
  const { project } = await createProject(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${project.id}`);
  await expect(status(page)).toBeVisible();
  await expect(page.getByRole('button', { name: '保存项目信息', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

async function checkIdentityAgain(page: Page) {
  const response = page.waitForResponse((r) => r.url().endsWith('/api/v1/users/me'));
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  return response;
}

test('聚焦时的会话检查临时失败不丢失未保存草稿，恢复后仍能保存', async ({ page, request }) => {
  const { project, workflow } = await createProject(request, definition());
  await page.goto(`/projects/${project.id}`);
  await move(page);
  const localPosition = await node(page).getAttribute('style');
  await page.route('**/api/v1/users/me', (route) =>
    route.fulfill({ status: 503, json: { message: '服务暂时不可用' } }),
  );
  expect((await checkIdentityAgain(page)).status()).toBe(503);
  await expect(
    page.getByText('暂时无法确认最新登录状态，当前编辑仍保留', { exact: true }),
  ).toBeVisible();
  await expect(node(page)).toHaveAttribute('style', localPosition!);
  await expect(status(page)).toHaveText('草稿未保存');
  await page.unroute('**/api/v1/users/me');
  await page.getByRole('button', { name: '重新检查登录状态' }).click();
  await expect(
    page.getByText('暂时无法确认最新登录状态，当前编辑仍保留', { exact: true }),
  ).toHaveCount(0);
  await expect(node(page)).toHaveAttribute('style', localPosition!);
  expect((await save(page)).ok()).toBeTruthy();
  await expect(status(page)).toHaveText(`草稿已保存 · 修订 ${workflow.revision + 1}`);
});

for (const code of [401, 403]) {
  test(`会话检查明确返回 ${code} 时仍隐藏受保护编辑器`, async ({ page, request }) => {
    const { project } = await createProject(request, definition());
    await page.goto(`/projects/${project.id}`);
    await expect(node(page)).toBeVisible();
    await page.route('**/api/v1/users/me', (route) =>
      route.fulfill({ status: code, json: { message: '没有访问权限' } }),
    );
    expect((await checkIdentityAgain(page)).status()).toBe(code);
    await expect(page.locator('.react-flow')).toHaveCount(0);
    if (code === 401) await expect(page).toHaveURL(/\/login/);
    else await expect(page.getByText('没有访问权限', { exact: true })).toBeVisible();
  });
}
