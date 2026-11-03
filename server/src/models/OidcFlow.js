import mongoose from 'mongoose';

/**
 * Short-lived OIDC Authorization Code + PKCE flow records.
 *
 * Why this exists: Chromium (Chrome/Edge) can drop or ignore the SSO session
 * cookie across the cross-site redirect to the ATOZAS IdP and back. Storing
 * state/PKCE keyed by the OIDC `state` value means the callback can complete
 * without relying on that cookie round-trip. Firefox was already tolerant;
 * this makes every browser behave the same.
 *
 * TTL index auto-deletes rows after `expiresAt` so abandoned flows do not
 * accumulate. Secrets here never leave the server.
 */
const oidcFlowSchema = new mongoose.Schema(
  {
    state: { type: String, required: true, unique: true, index: true },
    nonce: { type: String, required: true },
    verifier: { type: String, required: true },
    returnTo: { type: String, default: '/' },
    // True for a `prompt=none` silent probe started from the ATOZAS homepage
    // card. On failure (no IdP session) the callback returns quietly to the
    // homepage instead of showing a login error — no forced sign-in.
    silent: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true },
);

oidcFlowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OidcFlow = mongoose.models.OidcFlow || mongoose.model('OidcFlow', oidcFlowSchema);

export default OidcFlow;
