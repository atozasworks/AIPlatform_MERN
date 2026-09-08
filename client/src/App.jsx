import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './store/auth.js';
import LoginPage from './pages/LoginPage.jsx';
import ChatPage from './pages/ChatPage.jsx';
import PublicChatPage from './pages/PublicChatPage.jsx';
import SharedChatPage from './pages/SharedChatPage.jsx';
import Spinner from './components/ui/Spinner.jsx';

// Session-scoped guards so an anonymous `/` visit starts ATOZAS SSO at most
// once and never loops. `atozasSsoEnabled` caches the server flag for the tab
// so repeated renders don't re-hit `/auth/atozas/status`.
let atozasSsoEnabled = null; // null = unknown, true/false once checked
const SSO_ATTEMPT_KEY = 'atozas_sso_attempt_at';
const SSO_LOOP_WINDOW_MS = 15000;

function recentSsoAttempt() {
  try {
    return Date.now() - (Number(sessionStorage.getItem(SSO_ATTEMPT_KEY)) || 0) < SSO_LOOP_WINDOW_MS;
  } catch {
    return false;
  }
}

function ProtectedRoute({ children }) {
  const status = useAuth((s) => s.status);
  const location = useLocation();
  if (status === 'loading') return <FullScreenLoader />;
  if (status !== 'authenticated') return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

function PublicOnlyRoute({ children }) {
  const status = useAuth((s) => s.status);
  if (status === 'loading') return <FullScreenLoader />;
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return children;
}

/**
 * `/` attempts ATOZAS SSO automatically for anonymous visitors when the server
 * reports SSO is enabled, so a cross-domain launch from the ATOZAS homepage
 * signs the user straight in. To avoid a flashing/looping screen:
 *   - the SSO-enabled flag is cached per tab (no repeated status calls),
 *   - a full-screen loader (never the public page) is shown while deciding,
 *   - a short-lived "attempt" marker breaks any redirect loop and falls back
 *     to the login page instead of bouncing forever.
 *
 * Escape hatch: `/?guest=1` keeps the old anonymous public-chat entrypoint.
 */
function HomeRoute() {
  const status = useAuth((s) => s.status);
  const location = useLocation();
  const isGuest = new URLSearchParams(location.search).get('guest') === '1';
  const [ssoEnabled, setSsoEnabled] = useState(atozasSsoEnabled);

  useEffect(() => {
    // A completed login clears the loop marker so future logouts can retry SSO.
    if (status === 'authenticated') {
      try {
        sessionStorage.removeItem(SSO_ATTEMPT_KEY);
      } catch {
        /* ignore */
      }
      return;
    }
    if (status !== 'anonymous' || isGuest) return;

    let cancelled = false;
    const decide = (enabled) => {
      if (cancelled) return;
      atozasSsoEnabled = enabled;
      setSsoEnabled(enabled);
      // Only redirect if enabled AND we are not already mid-loop.
      if (enabled && !recentSsoAttempt()) {
        try {
          sessionStorage.setItem(SSO_ATTEMPT_KEY, String(Date.now()));
        } catch {
          /* ignore */
        }
        window.location.assign('/auth/atozas?returnTo=/');
      }
    };

    if (atozasSsoEnabled !== null) {
      decide(atozasSsoEnabled);
      return () => {
        cancelled = true;
      };
    }
    fetch('/auth/atozas/status', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => decide(Boolean(body?.data?.enabled)))
      .catch(() => decide(false));

    return () => {
      cancelled = true;
    };
  }, [status, isGuest]);

  if (status === 'loading') return <FullScreenLoader />;
  if (status === 'authenticated') return <ChatPage />;

  // Anonymous from here on.
  if (isGuest) return <PublicChatPage />;
  // SSO enabled but we already bounced once and came back still anonymous:
  // stop looping and let the user choose a login method.
  if (ssoEnabled && recentSsoAttempt()) return <Navigate to="/login" replace />;
  // SSO explicitly disabled: original public-chat entrypoint.
  if (ssoEnabled === false) return <PublicChatPage />;
  // Unknown yet, or redirect in flight: clean loader (no content flash).
  return <FullScreenLoader />;
}

function FullScreenLoader() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size={28} />
    </div>
  );
}

export default function App() {
  const bootstrap = useAuth((s) => s.bootstrap);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicOnlyRoute>
            <LoginPage />
          </PublicOnlyRoute>
        }
      />
      {/* Registration is implicit (accounts are created on first OTP/Google login). */}
      <Route path="/register" element={<Navigate to="/login" replace />} />
      {/* Explicit guest chat URL (same page as anonymous `/`). */}
      <Route
        path="/chat"
        element={
          <PublicOnlyRoute>
            <PublicChatPage />
          </PublicOnlyRoute>
        }
      />
      <Route path="/share/:token" element={<SharedChatPage />} />
      <Route path="/" element={<HomeRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
