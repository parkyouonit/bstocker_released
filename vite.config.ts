import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiProxy = {
  '/api': {
    target: 'http://127.0.0.1:8787',
    changeOrigin: true,
  },
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4174,
    strictPort: true,
    host: '0.0.0.0',
    proxy: apiProxy,
  },
  preview: {
    port: 4174,
    strictPort: true,
    host: '0.0.0.0',
    proxy: apiProxy,
  },
  build: {
    target: 'es2022',
  },
})
