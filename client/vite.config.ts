import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vitejs.dev/config/
export default defineConfig({
  // Base path for GitHub Pages under https://<user>.github.io/offgram/
  base: '/offgram/',
  plugins: [react(), nodePolyfills()],
  resolve: {
    alias: {
      buffer: 'buffer',
      process: 'process/browser',
      stream: 'stream-browserify',
      crypto: 'crypto-browserify',
      util: 'util',
      events: 'events',
      assert: 'assert',
      path: 'path-browserify',
      zlib: 'browserify-zlib',
      'string_decoder': 'string_decoder',
    },
  },
  define: {
    global: 'globalThis',
    'process.browser': true,
    'process.env': {},
  },
  optimizeDeps: {
    include: [
      'buffer',
      'process/browser',
      'stream-browserify',
      'crypto-browserify',
      'util',
      'events',
      'assert',
      'path-browserify',
      'browserify-zlib',
      'string_decoder',
      'safe-buffer',
      'readable-stream',
      'browserify-sign',
      'bn.js',
    ],
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  server: {
    // Эта опция позволяет принимать запросы с любого хоста
    allowedHosts: true,
    // Эта новая опция заставляет сервер Vite слушать все сетевые интерфейсы
    // и позволяет таким инструментам, как LocalXpose, подключаться.
    host: true,
    https: false
  }
})
