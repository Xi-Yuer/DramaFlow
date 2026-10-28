import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import shared from '../../vitest.shared.mjs';

export default defineConfig({
  ...shared,
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
