import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
//
// Base44 is gone: the old @base44/vite-plugin used to provide the `@/` → `/src/`
// import alias, so we declare it here as a plain Vite resolve.alias (matching the
// `@/*` paths mapping in jsconfig.json).
//
// For the EVENT we run `npm run build` + `npm run serve` (single origin: the Node
// host serves dist/ and owns /ws). For DEVELOPMENT with HMR (`npm run dev`) the
// client connects same-origin to `/ws` on the Vite port, so we proxy that to the
// separately-run Node host (`npm run serve`, default :8080). Override the target
// port with VITE_WS_TARGET if you run the host on a non-default PORT.
const WS_TARGET = process.env.VITE_WS_TARGET || 'ws://localhost:8080'
export default defineConfig({
  logLevel: 'error', // Suppress warnings, only show errors
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/ws': { target: WS_TARGET, ws: true },
    },
  },
})
