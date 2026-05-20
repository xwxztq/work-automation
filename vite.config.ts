import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const host = process.env.LINEAR_AUTOMATION_HOST?.trim() || '127.0.0.1'
const apiHost = process.env.LINEAR_AUTOMATION_API_HOST?.trim() || host
const apiPort = process.env.LINEAR_AUTOMATION_API_PORT?.trim() || '4378'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host,
    port: 8888,
    proxy: {
      '/api': `http://${apiHost}:${apiPort}`,
    },
  },
  preview: {
    host,
    port: 8888,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
