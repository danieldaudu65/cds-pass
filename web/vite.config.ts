import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Keep Firebase in its own cached file. Do NOT list the 3D libraries here: naming them as a
        // manual chunk made every phone download ~960 KB of 3D code before the app could start.
        // Left alone, they stay inside the lazily loaded Hero3D file and only load on the welcome screen.
        manualChunks(id) {
          if (id.includes('/node_modules/firebase/') || id.includes('/node_modules/@firebase/')) return 'firebase';
        },
      },
    },
  },
});
