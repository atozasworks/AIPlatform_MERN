/**
 * Streams a chat response using fetch + ReadableStream (not EventSource, which
 * cannot send POST bodies or cookies with a JSON payload cleanly). Parses the
 * SSE wire format (event:/data: lines) and invokes handlers as events arrive.
 *
 * Returns an object with `.cancel()` to stop generation (aborts the request).
 */
export function streamChat(conversationId, payload, handlers = {}) {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`/api/v1/conversations/${conversationId}/stream`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || `Stream failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const event = parseFrame(frame);
          if (event) dispatch(event, handlers);
        }
      }
      handlers.onClose?.();
    } catch (err) {
      if (controller.signal.aborted) handlers.onCancel?.();
      else handlers.onError?.(err);
    }
  })();

  return { cancel: () => controller.abort() };
}

function parseFrame(frame) {
  let event = 'message';
  const dataLines = [];
  for (const line of frame.split('\n')) {
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

function dispatch({ event, data }, handlers) {
  switch (event) {
    case 'meta':
      handlers.onMeta?.(data);
      break;
    case 'token':
      handlers.onToken?.(data.text);
      break;
    case 'title':
      handlers.onTitle?.(data.title);
      break;
    case 'done':
      handlers.onDone?.(data);
      break;
    case 'error':
      handlers.onError?.(new Error(data.message));
      break;
    default:
      break;
  }
}

export default streamChat;
