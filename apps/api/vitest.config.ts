import { defineConfig } from 'vitest/config';
import shared from '../../config/testing/vitest.shared.mjs';

export default defineConfig({
  ...shared,
  test: {
    ...shared.test,
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
  },
});
