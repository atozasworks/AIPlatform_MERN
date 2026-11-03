/**
 * Thin fetch wrapper for the JSON REST API. Uses cookies (credentials: include)
 * so the browser sends the HTTP-only auth cookies automatically. On a 401 it
 * attempts a one-time token refresh, then retries the original request.
 */
const BASE = '/api/v1';

let refreshing = null;

async function request(path, { method = 'GET', body, headers = {}, _retried = false } = {}) {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: {
      // Let the browser set multipart boundary for FormData.
      ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !_retried && !path.startsWith('/auth/')) {
    const ok = await tryRefresh();
    if (ok) return request(path, { method, body, headers, _retried: true });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const err = new Error(data?.error?.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.error?.code;
    err.details = data?.error?.details;
    throw err;
  }
  return data.data;
}

/**
 * Single-flight access-token refresh. Concurrent 401s (e.g. a REST call and an
 * SSE stream at once) share one `/auth/refresh` round trip. Exported so the SSE
 * client in `stream.js` reuses the exact same de-duplicated refresh.
 */
export function tryRefresh() {
  if (!refreshing) {
    refreshing = fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  delete: (path) => request(path, { method: 'DELETE' }),
  /** Multipart upload (FormData). Do not set Content-Type manually. */
  upload: (path, formData) => request(path, { method: 'POST', body: formData }),
};

export default api;
