/**
 * Fetch wrapper for the admin REST API. Uses the shared httpOnly session
 * cookies (credentials: 'include'), so it never handles tokens directly. On a
 * 401 it tries a one-time refresh against the app's /auth/refresh (the refresh
 * cookie is scoped to /api/v1/auth) and retries once.
 */
const BASE = '/api/v1';

let refreshing = null;

function tryRefresh() {
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

async function request(path, { method = 'GET', body, _retried = false } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  // Never auto-refresh the login call itself.
  if (res.status === 401 && !_retried && path !== '/admin/login') {
    const ok = await tryRefresh();
    if (ok) return request(path, { method, body, _retried: true });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const err = new Error(data?.error?.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.error?.code;
    throw err;
  }
  return data.data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
};

/** Builds a query string from a params object, skipping empty values. */
export function qs(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

export default api;
