import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const apiProxy = {
  '/api': {
    target: 'http://127.0.0.1:8787',
    changeOrigin: true,
  },
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), '')
  const allowedHosts = String(environment.APP_ALLOWED_HOSTS || '')
    .split(',')
    .map(host => host.trim())
    .filter(Boolean)

  return {
    plugins: [react()],
    server: {
      port: 4174,
      strictPort: true,
      host: '0.0.0.0',
      allowedHosts,
      proxy: apiProxy,
    },
    preview: {
      port: 4174,
      strictPort: true,
      host: '0.0.0.0',
      allowedHosts,
      proxy: apiProxy,
    },
    build: {
      target: 'es2022',
    },
  }
})
