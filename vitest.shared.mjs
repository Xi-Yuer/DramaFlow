import { defineConfig } from 'vitest/config';

// Turbo 控制包级并发；每个 Vitest 进程另设上限，避免按 CPU 数重复扩张。
export default defineConfig({
  test: {
    maxWorkers: 2,
    include: ['test/**/*.{test,spec}.{ts,tsx}'],
  },
});
