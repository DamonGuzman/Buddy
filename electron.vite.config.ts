import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/preload/overlay.ts'),
          panel: resolve(__dirname, 'src/preload/panel.ts'),
        },
      },
    },
  },
  renderer: {
    // Tailwind v4 (CSS-first config) powers the PANEL renderer's shadcn/ui
    // styling; the plugin only transforms CSS that imports tailwind, so the
    // overlay renderer's plain CSS passes through untouched.
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        // shadcn-style alias, scoped to the panel renderer's vendored ui kit.
        '@': resolve(__dirname, 'src/renderer/panel'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          panel: resolve(__dirname, 'src/renderer/panel/index.html'),
        },
      },
    },
  },
});
