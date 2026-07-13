import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several suites own local WS/HTTP servers and PowerShell UIA daemons.
    // Serial files prevent port/daemon contention that made max-parallel CI flaky.
    maxWorkers: 1,
    fileParallelism: false,
  },
});
