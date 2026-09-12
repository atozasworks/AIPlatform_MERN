import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthProvider, GoogleLoginButton, EmailOtpLogin } from 'atozas-react-auth-kit';
import 'atozas-react-auth-kit/styles.css';
import { useAuth } from '../store/auth.js';
import AuthLayout from '../components/auth/AuthLayout.jsx';
import AtozasButton from '../components/auth/AtozasButton.jsx';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const GOOGLE_ALLOWED_ORIGINS = String(import.meta.env.VITE_GOOGLE_ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function googleAllowedOnThisOrigin() {
  if (typeof window === 'undefined') return true;
  if (!GOOGLE_ALLOWED_ORIGINS.length) return true;
  return GOOGLE_ALLOWED_ORIGINS.includes(window.location.origin);
}

/**
 * Login screen powered by atozas-react-auth-kit. The kit's components call our
 * atozas-auth-kit-express endpoints (/api/v1/auth). On success the server sets
 * the app's httpOnly cookie session (see authBridge), so we simply hydrate the
 * app's own auth store from /auth/me and continue.
 *
 * ATOZAS SSO is opt-in: this page never auto-redirects to atozasindia.in.
 * The user must click "Continue with ATOZAS" (`GET /auth/atozas`).
 */
export default function LoginPage() {
  const googleClientId = googleAllowedOnThisOrigin() ? GOOGLE_CLIENT_ID : '';
  return (
    <AuthProvider apiUrl="/api/v1/auth" googleClientId={googleClientId} enableLocalStorage>
      <LoginInner />
    </AuthProvider>
  );
}

function LoginInner() {
  const hasGoogle = googleAllowedOnThisOrigin() && Boolean(GOOGLE_CLIENT_ID);
  const bootstrap = useAuth((s) => s.bootstrap);
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [sso, setSso] = useState({ enabled: false, checked: false });

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams(window.location.search);
    if (params.get('sso_error')) {
      setError('ATOZAS sign-in did not complete. Please try again.');
    }
    fetch('/auth/atozas/status', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!alive || !body?.data) return;
        setSso({ enabled: Boolean(body.data.enabled), checked: true });
      })
      .catch(() => alive && setSso((s) => ({ ...s, checked: true })));
    return () => {
      alive = false;
    };
  }, []);

  const onSuccess = useCallback(async () => {
    setError('');
    await bootstrap();
    navigate('/', { replace: true });
  }, [bootstrap, navigate]);

  const onError = useCallback((err) => {
    const data = err?.response?.data;
    setError(data?.error || data?.details || err?.message || 'Sign-in failed. Please try again.');
  }, []);

  return (
    <AuthLayout title="Sign in to AtozAS AI" subtitle="No password needed — use your email or Google">
      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {sso.enabled && (
        <div className="mb-5">
          <AtozasButton returnTo="/" />
        </div>
      )}

      {(hasGoogle || sso.enabled) && (
        <>
          {hasGoogle && (
            <div className="mb-5 flex justify-center">
              <GoogleLoginButton onSuccess={onSuccess} onError={onError} />
            </div>
          )}
          <div className="mb-5 flex items-center gap-3 text-xs uppercase tracking-wide text-slate-400">
            <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
            or with email
            <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
          </div>
        </>
      )}

      <EmailOtpLogin onSuccess={onSuccess} onError={onError} />

      <p className="mt-6 text-center text-sm text-slate-500">
        <Link to="/" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
          Continue as guest without signing in
        </Link>
      </p>
    </AuthLayout>
  );
}
