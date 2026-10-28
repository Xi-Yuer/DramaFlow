import { defineConfig } from 'vitest/config';
import shared from '../../vitest.shared.mjs';

export default defineConfig({
  ...shared,
  test: {
    ...shared.test,
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
