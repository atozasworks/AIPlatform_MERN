import http from 'node:http';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Fresh socket per request (no keep-alive) to avoid stale-socket ECONNRESETs
// against the dev backend, mirroring the main client's proxy setup.
const proxyAgent = new http.Agent({ keepAlive: false });

// The admin panel is only ever served same-origin (Express at /admin, behind
// the same domain as the API). Vite stamps a `crossorigin` attribute on the
// emitted <script>/<link> tags, which forces the browser to fetch them in CORS
// mode and send an Origin header. The API's CORS allowlist does not include the
// server's own origin, so those same-origin assets would be rejected and the
// app would fail to boot. Stripping the attribute keeps the fetches in plain
// same-origin mode and removes the dependency on the CORS allowlist entirely.
function stripCrossorigin() {
  return {
    name: 'strip-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(?:="[^"]*")?/g, '');
    },
  };
}

const API_TARGET = 'http://localhost:5000';

// The admin panel is deployed under /admin, so every asset URL and the client
// router must be prefixed. In production Express serves the build at /admin
// (see server/src/app.js).
export default defineConfig({
  base: '/admin/',
  plugins: [react(), stripCrossorigin()],
  server: {
    port: 5174,
    proxy: {
      // Same-origin API + auth during dev so the httpOnly session cookies flow.
      // The browser sends `Origin: http://localhost:5174`, which is not in the
      // API's CORS allowlist. Rewriting it to the target's own origin makes the
      // proxied call same-origin to the backend without widening the allowlist.
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        agent: proxyAgent,
        headers: { origin: API_TARGET },
      },
      '/auth': {
        target: API_TARGET,
        changeOrigin: true,
        agent: proxyAgent,
        headers: { origin: API_TARGET },
      },
    },
  },
});
