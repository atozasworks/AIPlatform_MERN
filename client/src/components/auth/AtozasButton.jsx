import { clearManualLogin } from '../../lib/sso.js';

/**
 * "Continue with ATOZAS" button.
 *
 * This is a plain top-level navigation to the backend OIDC entrypoint
 * (`GET /auth/atozas`), which starts Authorization Code + PKCE server-side and
 * redirects to the ATOZAS identity provider. No tokens or secrets are ever
 * handled in the browser. Rendered by LoginPage only when the server reports
 * ATOZAS SSO is enabled.
 */
export default function AtozasButton({ returnTo = '/' }) {
  const href = `/auth/atozas?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <a
      href={href}
      onClick={() => clearManualLogin()}
      className="flex w-full items-center justify-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
      data-testid="atozas-sso-button"
    >
      <span
        aria-hidden="true"
        className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-[10px] font-bold text-white"
      >
        A
      </span>
      Continue with ATOZAS
    </a>
  );
}
