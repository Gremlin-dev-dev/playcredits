import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { setupFiles: ['tests/setup.ts'], fileParallelism: false, hookTimeout: 30000, testTimeout: 30000 },
});
