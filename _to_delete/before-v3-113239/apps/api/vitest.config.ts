import { defineConfig } from 'vitest/config';
export default defineConfig({
  esbuild: { target: 'es2022', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } },
  test: { globalSetup: ['../../packages/database/test/global-setup.ts'], fileParallelism: false, testTimeout: 30000, hookTimeout: 60000 },
});
