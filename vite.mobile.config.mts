import { renameSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Builds the Android app's web layer: the same renderer as the desktop app, with
// window.forge talking to the paired PC over Tailscale instead of Electron IPC.
export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  resolve: { alias: { '@shared': resolve('src/shared') } },
  plugins: [
    react(),
    {
      // Capacitor loads index.html from the web dir
      name: 'mobile-index',
      apply: 'build',
      closeBundle: () => renameSync(resolve('mobile/www/mobile.html'), resolve('mobile/www/index.html'))
    }
  ],
  build: {
    outDir: resolve('mobile/www'),
    emptyOutDir: true,
    target: 'chrome110',
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input: { index: resolve('src/renderer/mobile.html') } }
  }
})
