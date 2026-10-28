import { defineConfig } from 'vitest/config';
import shared from '../../config/testing/vitest.shared.mjs';

export default defineConfig({
  ...shared,
  test: {
    ...shared.test,
    include: ['test/**/*.storage-spec.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
