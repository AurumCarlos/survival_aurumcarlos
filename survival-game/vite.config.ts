import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Keep engine libraries in their own long-cached chunk.
        manualChunks: { three: ['three'], cannon: ['cannon-es'] },
      },
    },
  },
});
