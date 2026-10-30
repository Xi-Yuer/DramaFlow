import { randomInt } from 'node:crypto';
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createDatabase } from '../../../packages/database/dist/index.js';
import { currentUserSchema, projectSchema, workflowResponseSchema } from '@dramaflow/contracts';
export { expect };
export const origin = 'http://127.0.0.1:3200';
const loginHeaders = {
  Origin: origin,
  'x-real-ip': `198.18.${randomInt(256)}.${randomInt(1, 255)}`,
};
type Session = Awaited<ReturnType<APIRequestContext['storageState']>>;
export const test = base.extend<object, { session: Session; foreignId: string }>({
  session: [
    async ({ playwright }, provide) => {
      const api = await playwright.request.newContext({
        baseURL: origin,
        extraHTTPHeaders: loginHeaders,
      });
      const login = await api.post('/api/auth/sign-in/email', {
        data: {
          email: process.env.WEB_TEST_OWNER_EMAIL,
          password: process.env.WEB_TEST_OWNER_PASSWORD,
        },
      });
      expect(login.status()).toBe(200);
      await provide(await api.storageState());
      await api.dispose();
    },
    { scope: 'worker' },
  ],
  storageState: async ({ session }, provide) => provide(session),
  foreignId: [
    async ({ playwright }, provide) => {
      const api = await playwright.request.newContext({
        baseURL: origin,
        extraHTTPHeaders: loginHeaders,
      });
      expect(
        (
          await api.post('/api/auth/sign-in/email', {
            data: {
              email: process.env.WEB_TEST_OTHER_EMAIL,
              password: process.env.WEB_TEST_OTHER_PASSWORD,
            },
          })
        ).ok(),
      ).toBeTruthy();
      const response = await api.post('/api/v1/projects', { data: { name: '他人的项目' } });
      const project = projectSchema.parse(await response.json());
      await provide(project.id);
      await api.dispose();
    },
    { scope: 'worker' },
  ],
});

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page, request }) => {
  const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
  if (
    process.env.DRAMAFLOW_INTEGRATION !== '1' ||
    url.pathname !== '/dramaflow_test' ||
    !['localhost', '127.0.0.1'].includes(url.hostname)
  )
    throw new Error('Web 测试只允许隔离开发库');
  const owner = currentUserSchema.parse(await (await request.get('/api/v1/users/me')).json());
  if (owner.email !== process.env.WEB_TEST_OWNER_EMAIL) throw new Error('拒绝清理非本轮测试用户');
  const db = createDatabase();
  try {
    await db.modelProvider.deleteMany({ where: { ownerId: owner.id } });
  } finally {
    await db.$disconnect();
  }
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

// 需要画布的测试显式创建两种资源，保存 Workflow 身份，不依赖 Project 的隐式默认对象。
export async function createProjectWithWorkflow(api: APIRequestContext, name: string) {
  const project = projectSchema.parse(
    await (
      await api.post('/api/v1/projects', { headers: { Origin: origin }, data: { name } })
    ).json(),
  );
  const response = await api.post(`/api/v1/projects/${project.id}/workflows`, {
    headers: { Origin: origin },
    data: { name: '测试工作流' },
  });
  expect(response.status()).toBe(201);
  const workflow = workflowResponseSchema.parse(await response.json());
  return { ...project, workflowId: workflow.id };
}
