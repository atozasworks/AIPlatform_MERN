import mongoose from 'mongoose';

const { Schema, model } = mongoose;

/**
 * Short-lived one-time passcode for passwordless email login.
 *
 * The plaintext code is never stored — only a salted SHA-256 hash. A TTL index
 * on `expiresAt` lets MongoDB purge expired codes automatically, and `attempts`
 * caps brute-force guessing against a delivered code.
 */
const emailOtpSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null },
    // Rate-limits resends per email independently of the IP-based limiter.
    lastSentAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

// MongoDB removes the document once `expiresAt` passes (expireAfterSeconds: 0).
emailOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailOtp = model('EmailOtp', emailOtpSchema);
export default EmailOtp;
