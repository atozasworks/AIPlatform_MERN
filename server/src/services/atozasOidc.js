import crypto from 'node:crypto';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/AppError.js';

/**
 * ATOZAS OpenID Connect client (relying party) helper.
 *
 * Implements the server-side half of Authorization Code + PKCE (S256) using
 * only Node's built-in `fetch` and `crypto` — no third-party OIDC dependency.
 *
 * Security invariants (do NOT relax):
 *  - client_secret, the authorization `code`, the PKCE `code_verifier` and any
 *    provider tokens (access/id/refresh) never leave the server and are never
 *    logged. Only non-sensitive metadata (issuer, endpoint host, error codes)
 *    may be logged.
 *  - `state` and PKCE are generated and validated here / in the route layer.
 */

const cfg = env.atozas;
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour

let discoveryCache = null; // { fetchedAt, endpoints }

/** Cryptographically strong base64url token of `bytes` random bytes. */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Creates a PKCE verifier + S256 challenge pair. */
export function createPkce() {
  const verifier = randomToken(48); // 64-char base64url, within RFC 7636 43–128
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

/** Opaque anti-CSRF state / OIDC nonce values. */
export function createState() {
  return randomToken(32);
}
export function createNonce() {
  return randomToken(32);
}

/**
 * Resolves the provider endpoints. Explicit env overrides win; otherwise the
 * OIDC discovery document is fetched from the issuer and cached briefly.
 */
export async function getEndpoints() {
  const explicit = {
    authorization_endpoint: cfg.authorizeUrl || undefined,
    token_endpoint: cfg.tokenUrl || undefined,
    userinfo_endpoint: cfg.userinfoUrl || undefined,
    revocation_endpoint: cfg.revokeUrl || undefined,
  };

  // If the caller supplied every endpoint we need, skip discovery entirely.
  if (explicit.authorization_endpoint && explicit.token_endpoint && explicit.userinfo_endpoint) {
    return explicit;
  }

  if (discoveryCache && Date.now() - discoveryCache.fetchedAt < DISCOVERY_TTL_MS) {
    return { ...discoveryCache.endpoints, ...pruneUndefined(explicit) };
  }

  if (!cfg.issuer) {
    throw new AppError(500, 'ATOZAS SSO is misconfigured: no issuer and incomplete endpoint overrides.');
  }

  const url = `${cfg.issuer}/.well-known/openid-configuration`;
  let doc;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);
    doc = await res.json();
  } catch (err) {
    logger.error({ err: err?.message, issuer: cfg.issuer }, 'ATOZAS OIDC discovery failed');
    throw new AppError(502, 'Could not reach the ATOZAS identity provider. Please try again.');
  }

  const endpoints = {
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    userinfo_endpoint: doc.userinfo_endpoint,
    revocation_endpoint: doc.revocation_endpoint,
  };
  discoveryCache = { fetchedAt: Date.now(), endpoints };
  return { ...endpoints, ...pruneUndefined(explicit) };
}

function pruneUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** Builds the provider authorize URL for the browser redirect. */
export async function buildAuthorizeUrl({ state, codeChallenge, nonce }) {
  const { authorization_endpoint: authorizeEndpoint } = await getEndpoints();
  if (!authorizeEndpoint) throw new AppError(500, 'ATOZAS authorize endpoint is not configured.');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    nonce,
  });
  if (cfg.homepageKey) params.set('homepage_key', cfg.homepageKey);

  const sep = authorizeEndpoint.includes('?') ? '&' : '?';
  return `${authorizeEndpoint}${sep}${params.toString()}`;
}

/**
 * Exchanges an authorization `code` for tokens. The `code`, `codeVerifier` and
 * client_secret are sent to the provider only and never returned to the client
 * or logged.
 */
export async function exchangeCode({ code, codeVerifier }) {
  const { token_endpoint: tokenEndpoint } = await getEndpoints();
  if (!tokenEndpoint) throw new AppError(500, 'ATOZAS token endpoint is not configured.');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: codeVerifier,
  });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };

  if (cfg.tokenAuthStyle === 'basic') {
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  } else {
    body.set('client_id', cfg.clientId);
    body.set('client_secret', cfg.clientSecret);
  }

  let res;
  try {
    res = await fetch(tokenEndpoint, { method: 'POST', headers, body });
  } catch (err) {
    logger.error({ err: err?.message }, 'ATOZAS token exchange request failed');
    throw new AppError(502, 'ATOZAS token exchange failed. Please try again.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // Log the provider error CODE only — never the code/verifier/secret/tokens.
    logger.warn({ status: res.status, error: data?.error }, 'ATOZAS token exchange rejected');
    throw AppError.unauthorized('ATOZAS sign-in could not be completed.');
  }
  return data; // { access_token, id_token?, token_type, expires_in, ... }
}

/** Fetches the OIDC userinfo claims with the provider access token. */
export async function fetchUserInfo(accessToken) {
  const { userinfo_endpoint: userinfoEndpoint } = await getEndpoints();
  if (!userinfoEndpoint) throw new AppError(500, 'ATOZAS userinfo endpoint is not configured.');

  let res;
  try {
    res = await fetch(userinfoEndpoint, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
  } catch (err) {
    logger.error({ err: err?.message }, 'ATOZAS userinfo request failed');
    throw new AppError(502, 'Could not load your ATOZAS profile. Please try again.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    logger.warn({ status: res.status }, 'ATOZAS userinfo rejected');
    throw AppError.unauthorized('ATOZAS sign-in could not be completed.');
  }
  return data; // { sub, email, email_verified?, name?, picture?, ... }
}

/**
 * Best-effort provider token revocation on logout. Failures are swallowed —
 * clearing the local session is what matters for the user.
 */
export async function revokeToken(token, tokenTypeHint = 'access_token') {
  const { revocation_endpoint: revocationEndpoint } = await getEndpoints().catch(() => ({}));
  if (!revocationEndpoint || !token) return;

  const body = new URLSearchParams({ token, token_type_hint: tokenTypeHint });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (cfg.tokenAuthStyle === 'basic') {
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  } else {
    body.set('client_id', cfg.clientId);
    body.set('client_secret', cfg.clientSecret);
  }

  try {
    await fetch(revocationEndpoint, { method: 'POST', headers, body });
  } catch (err) {
    logger.warn({ err: err?.message }, 'ATOZAS token revocation failed (ignored)');
  }
}

export default {
  createPkce,
  createState,
  createNonce,
  getEndpoints,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
  revokeToken,
};
