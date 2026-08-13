/**
 * SSE client for chat generation.
 *
 * Uses fetch + ReadableStream rather than EventSource, which cannot POST a JSON
 * body or set headers. Handles the full ATOZAS event protocol:
 *
 *   meta | queued | started | token | citation | completed | cancelled | error | heartbeat
 *
 * Two properties matter for correctness:
 *
 *  - Every frame carries a `seq`. The client tracks the highest one it has
 *    rendered, so reconnecting mid-generation replays only what it missed. That
 *    is what prevents duplicated text after a refresh or a dropped connection.
 *
 *  - `cancel()` tells the *server* to stop (the worker runs in another process,
 *    so aborting the browser's fetch alone would leave it generating). The
 *    fetch is aborted only after the cancel request is dispatched.
 */

import { tryRefresh } from './api.js';

const BASE = '/api/v1';

/**
 * Runs a fetch and, on a 401, refreshes the access token once and retries.
 *
 * The SSE endpoints are hit with raw fetch (EventSource cannot POST a body or
 * carry these headers), so they bypass the api.js interceptor. Without this a
 * short-lived access token that expires between turns surfaces as a mid-chat
 * "Authentication required" even though the user is still logged in.
 */
async function fetchWithRefresh(url, init) {
  const res = await fetch(url, init);
  if (res.status !== 401) return res;
  const refreshed = await tryRefresh();
  if (!refreshed) return res;
  return fetch(url, init);
}

export function streamChat(conversationId, payload, handlers = {}) {
  const controller = new AbortController();
  const state = { jobId: null, lastSeq: 0, finished: false };

  const run = async () => {
    try {
      const res = await fetchWithRefresh(`${BASE}/conversations/${conversationId}/stream`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          // Belt-and-braces against a proxy that ignores the response headers.
          'X-No-Compression': '1',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        const err = new Error(data?.error?.message || `Stream failed (${res.status})`);
        err.status = res.status;
        err.code = data?.error?.code;
        err.details = data?.error?.details;
        throw err;
      }

      await consume(res.body, state, handlers);

      // Server closed without a terminal event (proxy timeout, restart).
      if (!state.finished) handlers.onClose?.({ jobId: state.jobId, lastSeq: state.lastSeq });
    } catch (err) {
      if (controller.signal.aborted) handlers.onCancel?.({ reason: 'client_aborted' });
      else handlers.onError?.(err);
    }
  };

  run();

  return {
    get jobId() {
      return state.jobId;
    },
    get lastSeq() {
      return state.lastSeq;
    },
    /** Stops generation server-side, then closes the local connection. */
    async cancel() {
      if (state.jobId) {
        await fetch(
          `${BASE}/conversations/${conversationId}/stream/${state.jobId}/cancel`,
          { method: 'POST', credentials: 'include' },
        ).catch(() => {});
      }
      controller.abort();
    },
  };
}

/**
 * Re-attaches to a generation already in flight, replaying from `lastSeq`.
 * Used after a page refresh or a network drop.
 */
export function resumeStream(conversationId, jobId, { lastSeq = 0 } = {}, handlers = {}) {
  const controller = new AbortController();
  const state = { jobId, lastSeq, finished: false };

  (async () => {
    try {
      const res = await fetchWithRefresh(
        `${BASE}/conversations/${conversationId}/stream/${jobId}?lastSeq=${lastSeq}`,
        { credentials: 'include', headers: { 'X-No-Compression': '1' }, signal: controller.signal },
      );
      if (!res.ok || !res.body) throw new Error(`Resume failed (${res.status})`);

      await consume(res.body, state, handlers);
      if (!state.finished) handlers.onClose?.({ jobId, lastSeq: state.lastSeq });
    } catch (err) {
      if (controller.signal.aborted) handlers.onCancel?.({ reason: 'client_aborted' });
      else handlers.onError?.(err);
    }
  })();

  return {
    get jobId() {
      return state.jobId;
    },
    get lastSeq() {
      return state.lastSeq;
    },
    async cancel() {
      await fetch(`${BASE}/conversations/${conversationId}/stream/${jobId}/cancel`, {
        method: 'POST',
        credentials: 'include',
      }).catch(() => {});
      controller.abort();
    },
  };
}

async function consume(body, state, handlers) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';

    for (const raw of frames) {
      const frame = parseFrame(raw);
      if (frame) dispatch(frame, state, handlers);
    }
  }
}

function parseFrame(raw) {
  let event = 'message';
  const dataLines = [];

  for (const line of raw.split('\n')) {
    // Comment lines (": padding") keep proxies from buffering; ignore them.
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }

  if (!dataLines.length) return null;

  try {
    return { event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

function dispatch({ event, data }, state, handlers) {
  // Ordering guard: a replayed frame the client already rendered is dropped.
  if (typeof data.seq === 'number') {
    if (data.seq <= state.lastSeq) return;
    state.lastSeq = data.seq;
  }

  switch (event) {
    case 'meta':
      if (data.jobId) state.jobId = data.jobId;
      handlers.onMeta?.(data);
      break;
    case 'queued':
      handlers.onQueued?.(data);
      break;
    case 'started':
      handlers.onStarted?.(data);
      break;
    case 'token':
      handlers.onToken?.(data.text);
      break;
    case 'citation':
      handlers.onCitations?.(data.sources || []);
      break;
    case 'title':
      handlers.onTitle?.(data.title);
      break;
    case 'completed':
      state.finished = true;
      handlers.onCompleted?.(data);
      break;
    case 'cancelled':
      state.finished = true;
      handlers.onCancel?.(data);
      break;
    case 'error':
      state.finished = true;
      handlers.onError?.(Object.assign(new Error(data.message), { code: data.code }));
      break;
    case 'heartbeat':
      handlers.onHeartbeat?.(data);
      break;
    default:
      break;
  }
}

export default streamChat;
