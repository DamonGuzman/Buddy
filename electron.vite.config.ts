import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
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
    plugins: [react()],
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
