/**
 * PM2 process definitions for ATOZAS AI.
 *
 * ── The critical constraint ──
 * `atozas-worker` MUST stay in fork mode with instances: 1.
 *
 * In cluster mode PM2 forks N copies of the process, each starting its own
 * BullMQ worker with its own LLM_WORKER_CONCURRENCY. The effective number of
 * simultaneous llama.cpp generations becomes N × concurrency, which silently
 * defeats the queue and will drive a CPU-only box into swap. The API is
 * stateless and safe to scale; the worker is not.
 *
 * Usage:
 *   pm2 start deploy/ecosystem.config.cjs --env production
 *   pm2 save
 *   pm2 startup systemd
 */

const path = require('node:path');

const SERVER_DIR = path.resolve(__dirname, '..', 'server');

module.exports = {
  apps: [
    {
      name: 'atozas-api',
      cwd: SERVER_DIR,
      script: 'src/index.js',
      // Two API workers handle hundreds of idle SSE connections comfortably;
      // they hold sockets, not CPU. Raise only if HTTP (not inference) is the
      // bottleneck — every instance competes with llama.cpp for the same cores.
      exec_mode: 'cluster',
      instances: 2,

      env: { NODE_ENV: 'development' },
      env_production: { NODE_ENV: 'production' },

      max_memory_restart: '600M',
      // Long SSE relays need time to drain on reload.
      kill_timeout: 20000,
      listen_timeout: 10000,
      wait_ready: false,

      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 3000,

      merge_logs: true,
      time: true,
      out_file: '/var/log/atozas/api-out.log',
      error_file: '/var/log/atozas/api-error.log',
    },

    {
      name: 'atozas-worker',
      cwd: SERVER_DIR,
      script: 'src/worker.js',

      // DO NOT CHANGE. See the note at the top of this file.
      exec_mode: 'fork',
      instances: 1,

      env: { NODE_ENV: 'development' },
      env_production: { NODE_ENV: 'production' },

      max_memory_restart: '800M',
      // Must exceed the longest plausible generation so a reload never
      // truncates an in-flight answer. Matches the worker's 45s force-exit.
      kill_timeout: 50000,

      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 5000,

      merge_logs: true,
      time: true,
      out_file: '/var/log/atozas/worker-out.log',
      error_file: '/var/log/atozas/worker-error.log',
    },
  ],
};
