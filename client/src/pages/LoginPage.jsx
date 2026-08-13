import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthProvider, GoogleLoginButton, EmailOtpLogin } from 'atozas-react-auth-kit';
import 'atozas-react-auth-kit/styles.css';
import { useAuth } from '../store/auth.js';
import AuthLayout from '../components/auth/AuthLayout.jsx';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const HAS_GOOGLE = Boolean(GOOGLE_CLIENT_ID);

/**
 * Login screen powered by atozas-react-auth-kit. The kit's components call our
 * atozas-auth-kit-express endpoints (/api/v1/auth). On success the server sets
 * the app's httpOnly cookie session (see authBridge), so we simply hydrate the
 * app's own auth store from /auth/me and continue.
 */
export default function LoginPage() {
  return (
    <AuthProvider apiUrl="/api/v1/auth" googleClientId={GOOGLE_CLIENT_ID} enableLocalStorage>
      <LoginInner />
    </AuthProvider>
  );
}

function LoginInner() {
  const bootstrap = useAuth((s) => s.bootstrap);
  const navigate = useNavigate();
  const [error, setError] = useState('');

  const onSuccess = useCallback(async () => {
    setError('');
    // The kit already established the app cookie session via the server bridge;
    // load the current user through the app's cookie-based /auth/me and go home.
    await bootstrap();
    navigate('/', { replace: true });
  }, [bootstrap, navigate]);

  const onError = useCallback((err) => {
    // Surface the server-provided reason (auth-kit responds with { error, details })
    // rather than axios's generic "Request failed with status code …".
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

      {HAS_GOOGLE && (
        <>
          <div className="mb-5 flex justify-center">
            <GoogleLoginButton onSuccess={onSuccess} onError={onError} />
          </div>
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
