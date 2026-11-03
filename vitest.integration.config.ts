import { defineConfig } from 'vitest/config';

// Integration tests share ONE disposable database — files run serially because
// fixtures like the SYSTEM principal, permission catalogue, and audit counts
// are global state that cannot be scoped per file.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30000,
  },
});
