import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'path';

// Builds the netbridge UI into ../ui — the collector serves that directory.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, '..', 'ui'),
    emptyOutDir: true,
    rollupOptions: {
      // The overlay (--overlay) is its own small page, embedded in the app.
      input: {
        main: path.resolve(__dirname, 'index.html'),
        overlay: path.resolve(__dirname, 'overlay.html'),
      },
    },
  },
});
