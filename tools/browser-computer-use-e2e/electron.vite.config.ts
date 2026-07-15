import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

const outDir = process.env.BUDDY_BROWSER_E2E_OUT_DIR;
if (!outDir) throw new Error('BUDDY_BROWSER_E2E_OUT_DIR is required');

export default defineConfig({
  main: {
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'main.ts'),
        },
      },
    },
  },
});
