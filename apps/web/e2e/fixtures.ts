import { randomInt } from 'node:crypto';
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { projectSchema } from '@dramaflow/contracts';
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
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});
