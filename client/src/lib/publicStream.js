/**
 * SSE client for pre-login guest chat sessions.
 * Mirrors the authenticated stream protocol but hits /api/v1/public/* only.
 */

const BASE = '/api/v1/public';

function createStreamer(startUrl, cancelUrlForJob) {
  return (payload, handlers = {}) => {
    const controller = new AbortController();
    const state = { jobId: null, lastSeq: 0, finished: false };

    const run = async () => {
      try {
        const res = await fetch(startUrl, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
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
      async cancel() {
        if (state.jobId) {
          await fetch(cancelUrlForJob(state.jobId), {
            method: 'POST',
            credentials: 'include',
          }).catch(() => {});
        }
        controller.abort();
      },
    };
  };
}

export function streamPublicChat(sessionId, payload, handlers = {}) {
  return createStreamer(
    `${BASE}/sessions/${sessionId}/stream`,
    (jobId) => `${BASE}/stream/${jobId}/cancel`,
  )(payload, handlers);
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
    case 'citation':
      handlers.onCitation?.(data);
      break;
    case 'token':
      handlers.onToken?.(data.text);
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

export default streamPublicChat;
