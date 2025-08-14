import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vitejs.dev/config/
export default defineConfig({
  // Base path for GitHub Pages under https://<user>.github.io/offgram/
  base: '/offgram/',
  plugins: [react(), nodePolyfills()],

  define: {
    global: 'globalThis',
    'process.browser': true,
    'process.env': {},
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