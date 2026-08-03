import { env } from '../config/env.js';

/**
 * Server-Sent Events transport helper.
 *
 * Three things this centralizes:
 *
 *  - Anti-buffering headers. Nginx, compression middleware and Cloudflare will
 *    all happily hold a token stream until it fills a buffer. `X-Accel-Buffering:
 *    no` plus disabling compression per-response is what makes tokens appear as
 *    they are generated rather than in one burst at the end.
 *
 *  - Heartbeats. CPU prefill on a 4B model can exceed 20 seconds before the
 *    first token. Without periodic traffic, proxies and mobile networks drop
 *    what looks like an idle connection.
 *
 *  - Write safety. Once a client disconnects, writing to the socket throws;
 *    every write is guarded so a late frame cannot crash the request.
 */
export function createSseChannel(req, res, { heartbeatMs = env.limits.sseHeartbeatMs } = {}) {
  let closed = false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Instructs Nginx not to buffer this response even if buffering is on.
    'X-Accel-Buffering': 'no',
  });

  // compression() would otherwise hold frames until its buffer fills.
  res.flushHeaders?.();

  const write = (chunk) => {
    if (closed || res.writableEnded) return false;
    try {
      res.write(chunk);
      // Present when compression middleware wrapped the response.
      res.flush?.();
      return true;
    } catch {
      closed = true;
      return false;
    }
  };

  // 2 KB comment defeats proxies that buffer until a minimum body size.
  write(`: ${' '.repeat(2048)}\n\n`);
  write(`retry: 3000\n\n`);

  const heartbeat = setInterval(() => {
    write(`event: heartbeat\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
  }, heartbeatMs);
  heartbeat.unref?.();

  const cleanupHandlers = [];

  const channel = {
    /** @param {string} event @param {object} data */
    send(event, data) {
      return write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },

    /** Registers work to run exactly once when the stream ends. */
    onClose(handler) {
      cleanupHandlers.push(handler);
    },

    get closed() {
      return closed || res.writableEnded;
    },

    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const handler of cleanupHandlers.splice(0)) {
        try {
          const result = handler();
          if (result?.catch) result.catch(() => {});
        } catch {
          // A failing cleanup handler must not block the others.
        }
      }
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          // Socket already gone.
        }
      }
    },
  };

  // Fires on client disconnect, navigation, and the Stop button.
  req.on('close', () => channel.close());
  res.on('error', () => channel.close());

  return channel;
}

export default createSseChannel;
