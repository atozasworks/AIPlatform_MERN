import http from 'node:http';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Dedicated proxy agent with keep-alive pooling OFF. Vite's default agent
// reuses idle sockets, but the backend (nodemon) closes them across restarts
// and on idle. Reusing a dead socket makes the first long-lived SSE /stream
// request fail with ECONNRESET and hang the UI. A fresh socket per request
// costs nothing in dev and removes the stale-socket class of failure entirely.
const proxyAgent = new http.Agent({ keepAlive: false });

// During development, proxy API + socket calls to the backend so cookies are
// same-origin and streaming works without CORS friction.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'AiChat — Unified AI Platform',
        short_name: 'AiChat',
        description: 'Chat with multiple AI models in one place.',
        theme_color: '#0b0f19',
        background_color: '#0b0f19',
        display: 'standalone',
        start_url: '/',
        icons: [
          // Scalable SVG icon works across install targets. Replace with rasterized
          // 192/512 PNGs before production for the widest platform support.
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        agent: proxyAgent,
        // SSE generations stay open for the whole reply; never time them out.
        proxyTimeout: 0,
        timeout: 0,
        configure: (proxy) => {
          // A proxy-side socket error (e.g. the backend restarting mid-stream)
          // must terminate the browser request, otherwise the client's fetch
          // hangs and the chat spins forever. End it with a JSON error the
          // stream client can parse into onError instead of leaving it open.
          proxy.on('error', (err, _req, res) => {
            if (!res || res.writableEnded) return;
            try {
              if (!res.headersSent && typeof res.writeHead === 'function') {
                res.writeHead(502, { 'Content-Type': 'application/json' });
              }
              res.end(
                JSON.stringify({
                  error: {
                    code: 'PROXY_ERROR',
                    message: `Dev proxy could not reach the API (${err?.code || err?.message || 'error'}).`,
                  },
                }),
              );
            } catch {
              res.destroy?.();
            }
          });
        },
      },
      '/socket.io': { target: 'http://localhost:5000', ws: true },
    },
  },
});
