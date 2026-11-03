/**
 * Shared ATOZAS SSO auto-start helpers.
 *
 * Both the root route (`/`, HomeRoute in App.jsx) and the login page
 * (`/login`, LoginPage.jsx) auto-start the ATOZAS OIDC flow for anonymous
 * visitors so that a cross-domain launch from the ATOZAS homepage
 * (atozasindia.in) signs the user straight in without ever showing a form.
 *
 * The two entry points MUST share the same loop guard: HomeRoute bounces `/`
 * to `/auth/atozas` and, if the browser comes back still anonymous, falls back
 * to `/login`. Without a shared marker the login page would immediately bounce
 * again and trap the user in an infinite `/login` ⇄ IdP redirect loop. Keeping
 * the marker here (one sessionStorage key) guarantees a single attempt per tab
 * within the window, after which the login form is shown instead.
 */

/** sessionStorage key holding the timestamp of the last SSO auto-start. */
export const SSO_ATTEMPT_KEY = 'atozas_sso_attempt_at';

/** How long a single SSO auto-start suppresses further auto-starts (loop break). */
export const SSO_LOOP_WINDOW_MS = 15000;

/** True when an SSO auto-start happened within the loop window (this tab). */
export function recentSsoAttempt() {
  try {
    return Date.now() - (Number(sessionStorage.getItem(SSO_ATTEMPT_KEY)) || 0) < SSO_LOOP_WINDOW_MS;
  } catch {
    return false;
  }
}

/** Records an SSO auto-start so a bounce-back does not immediately re-trigger. */
export function markSsoAttempt() {
  try {
    sessionStorage.setItem(SSO_ATTEMPT_KEY, String(Date.now()));
  } catch {
    /* ignore — a private/blocked storage just disables loop protection */
  }
}

/** Clears the marker once a login completes so a later logout can retry SSO. */
export function clearSsoAttempt() {
  try {
    sessionStorage.removeItem(SSO_ATTEMPT_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Set after the user explicitly logs out of THIS app. Suppresses auto-SSO for
 * the rest of the tab so they stay on the login form instead of bouncing
 * straight back through the ATOZAS IdP (which still has their homepage
 * session). A later homepage launch or "Continue with ATOZAS" click starts a
 * new tab/clears this flag and auto-login works again.
 */
export const SSO_MANUAL_KEY = 'atozas_sso_manual';

export function markManualLogin() {
  try {
    sessionStorage.setItem(SSO_MANUAL_KEY, '1');
  } catch {
    /* ignore */
  }
}

export function wantsManualLogin() {
  try {
    return sessionStorage.getItem(SSO_MANUAL_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearManualLogin() {
  try {
    sessionStorage.removeItem(SSO_MANUAL_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * True for Vite/local hosts. Local anonymous visits must stay on this app —
 * auto-starting OIDC would bounce the browser to the ATOZAS IdP
 * (atozasindia.in) and make `localhost:5173` look like the company homepage.
 * Production still auto-starts SSO so a homepage card click can sign the user in.
 */
export function isLocalDevHost() {
  if (import.meta.env.DEV) return true;
  try {
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

/** Builds the backend OIDC entrypoint URL, preserving a safe same-site returnTo. */
export function atozasStartUrl(returnTo = '/') {
  const target = typeof returnTo === 'string' && returnTo.startsWith('/') ? returnTo : '/';
  return `/auth/atozas?returnTo=${encodeURIComponent(target)}`;
}
