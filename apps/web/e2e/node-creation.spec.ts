import type { APIRequestContext, Page } from '@playwright/test';
import { nodeTypeManifestListSchema, workflowResponseSchema } from '@dramaflow/contracts';
import { test, expect, origin, createProjectWithWorkflow } from './fixtures.js';

const status = (page: Page) => page.getByRole('status', { name: '工作流草稿状态' });
const nodes = (page: Page) => page.locator('.react-flow__node');
async function readWorkflow(request: APIRequestContext, projectId: string, workflowId: string) {
  return workflowResponseSchema.parse(
    await (await request.get(`/api/v1/projects/${projectId}/workflows/${workflowId}`)).json(),
  );
}
async function createProject(request: APIRequestContext) {
  return await createProjectWithWorkflow(request, '画布测试项目');
}
async function save(page: Page) {
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.url().endsWith('/draft'),
  );
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  expect((await saved).ok()).toBeTruthy();
}

test('从真实目录向空画布和已有画布添加 incomplete 节点，按视口换算坐标并保存刷新', async ({
  page,
  request,
}) => {
  const project = await createProject(request);
  const viewport = { x: 175, y: -80, zoom: 0.7 };
  expect(
    (
      await request.put(`/api/v1/projects/${project.id}/workflows/${project.workflowId}`, {
        headers: { Origin: origin },
        data: { expectedMetadataRevision: 1, name: '测试工作流', viewport },
      })
    ).ok(),
  ).toBeTruthy();
  const catalog = nodeTypeManifestListSchema.parse(
    await (await request.get('/api/v1/workflow/node-types')).json(),
  );
  const manifest = catalog.find((item) => item.type === 'ai.text_generate')!;
  expect(manifest).toBeDefined();
  await page.goto(`/projects/${project.id}/workflows/${project.workflowId}`);
  await expect(nodes(page)).toHaveCount(0);
  await page.getByRole('button', { name: '添加节点', exact: true }).click();
  const option = page.getByRole('button', {
    name: `添加 ${manifest.metadata.name} · v${manifest.version}`,
    exact: true,
  });
  await expect(option).toBeVisible();
  await expect(option).toContainText('AI');
  await expect(option.locator('svg')).toHaveCount(1);
  if (manifest.metadata.description)
    await expect(option).toContainText(manifest.metadata.description);
  await page.screenshot({ path: test.info().outputPath('node-picker.png') });
  const bounds = (await page.locator('.canvas-stage').boundingBox())!;
  await option.click();
  await expect(nodes(page)).toHaveCount(1);
  await expect(status(page)).toHaveText('草稿未保存');
  const firstId = await nodes(page).first().getAttribute('data-id');
  expect(firstId).toBeTruthy();
  await save(page);
  const first = await readWorkflow(request, project.id, project.workflowId);
  expect(first.draft.nodes).toHaveLength(1);
  expect(first.draft.nodes[0]).toMatchObject({
    id: firstId,
    type: manifest.type,
    typeVersion: manifest.version,
    name: manifest.metadata.name,
    inputs: {},
    config: {},
  });
  expect(first.draft.nodes[0].ui.position.x).toBeCloseTo(
    (Math.max(24, (bounds.width - 300) / 2) - viewport.x) / viewport.zoom,
    3,
  );
  expect(first.draft.nodes[0].ui.position.y).toBeCloseTo(
    (Math.min(120, bounds.height / 3) - viewport.y) / viewport.zoom,
    3,
  );
  expect(first.draft.nodes[0]).not.toHaveProperty('preset');
  expect(first.draft.edges).toEqual([]);
  expect(first.draft.inputs).toEqual([]);
  expect(first.draft.outputs).toEqual([]);
  await page.reload();
  await expect(nodes(page)).toHaveCount(1);
  await expect(nodes(page).first()).toHaveAttribute('data-id', firstId!);
  await expect(status(page)).toHaveText(`草稿已保存 · 修订 ${first.revision}`);
  await page.getByRole('button', { name: '添加节点', exact: true }).click();
  await page
    .getByRole('button', {
      name: `添加 ${manifest.metadata.name} · v${manifest.version}`,
      exact: true,
    })
    .click();
  await expect(nodes(page)).toHaveCount(2);
  await expect(status(page)).toHaveText('草稿未保存');
  await save(page);
  const second = await readWorkflow(request, project.id, project.workflowId);
  expect(second.draft.nodes[0]).toEqual(first.draft.nodes[0]);
  expect(second.draft.nodes[1].ui.position).not.toEqual(first.draft.nodes[0].ui.position);
  expect(new Set(second.draft.nodes.map((node) => node.id)).size).toBe(2);
  await page.reload();
  await expect(nodes(page)).toHaveCount(2);
  await expect(status(page)).toHaveText(`草稿已保存 · 修订 ${second.revision}`);
  await page.screenshot({ path: test.info().outputPath('created-nodes.png') });
});

test('Picker 使用目录中的任意类型、版本、描述和默认配置，不依赖文本节点', async ({
  page,
  request,
}) => {
  const project = await createProject(request);
  const catalog = nodeTypeManifestListSchema.parse([
    {
      type: 'data.example',
      version: 9,
      executionKind: 'action',
      metadata: {
        name: '示例转换',
        description: '仅用于验证通用目录创建',
        category: 'data',
        icon: 'data',
      },
      inputs: [],
      outputs: [],
      config: [{ key: 'enabled', name: '启用', type: 'boolean', defaultValue: false }],
    },
  ]);
  await page.route('**/api/v1/workflow/node-types', (route) => route.fulfill({ json: catalog }));
  await page.goto(`/projects/${project.id}/workflows/${project.workflowId}`);
  await page.getByRole('button', { name: '添加节点', exact: true }).click();
  const option = page.getByRole('button', { name: '添加 示例转换 · v9', exact: true });
  await expect(option).toContainText('仅用于验证通用目录创建');
  await expect(option).toContainText('数据');
  await option.click();
  await expect(nodes(page)).toHaveCount(1);
  await expect(nodes(page).first()).toContainText('示例转换 · v9');
  await expect(nodes(page).first()).toContainText('关闭');
  await expect(status(page)).toHaveText('草稿未保存');
});

for (const invalidCatalog of [false, true]) {
  test(`目录${invalidCatalog ? '结构不合法' : '加载失败'}时不能创建伪造节点，重试成功后恢复入口`, async ({
    page,
    request,
  }) => {
    const project = await createProject(request);
    await page.route('**/api/v1/workflow/node-types', (route) =>
      route.fulfill(
        invalidCatalog
          ? { json: [{ type: 'invalid' }] }
          : { status: 503, json: { message: '目录暂不可用' } },
      ),
    );
    await page.goto(`/projects/${project.id}/workflows/${project.workflowId}`);
    await expect(page.getByText('节点目录加载失败，已有草稿仍保留。')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole('button', { name: '添加节点', exact: true })).toBeDisabled();
    await expect(nodes(page)).toHaveCount(0);
    await expect(status(page)).toHaveText('草稿已保存 · 修订 1');
    expect((await readWorkflow(request, project.id, project.workflowId)).draft.nodes).toEqual([]);
    await page.unroute('**/api/v1/workflow/node-types');
    await page.getByRole('button', { name: '重试加载目录', exact: true }).click();
    await expect(page.getByRole('button', { name: '添加节点', exact: true })).toBeEnabled();
  });
}
