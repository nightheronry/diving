import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: {
    format: 'es',
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'vendor-three';
          if (id.includes('/src/ocean/')) return 'ocean-sim';
          if (id.includes('/src/coral-system.js')) return 'world-ecology';
          if (id.includes('/src/shark-system.js')) return 'marine-wildlife';
          if (id.includes('/src/audio/')) return 'ocean-audio';
        },
      },
    },
  },
});
