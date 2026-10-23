import { defineConfig } from 'vitest/config';
export default defineConfig({
  // Integration tests reuse the API's fixtures, which load NestJS sources (decorators) and need the shared test database.
  esbuild: { target: 'es2022', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } },
  test: { globalSetup: ['../../packages/database/test/global-setup.ts'], fileParallelism: false, testTimeout: 30000, hookTimeout: 60000 },
});
