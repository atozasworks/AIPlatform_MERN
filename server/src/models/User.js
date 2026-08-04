import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const { Schema, model } = mongoose;

/**
 * User account. Passwords are hashed with bcrypt; the hash is never selected by
 * default and never serialized to JSON. `refreshTokenVersion` supports global
 * session invalidation ("log out from all devices").
 */
const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email address'],
    },
    // Optional: accounts created via email OTP or Google Sign-In have no password.
    passwordHash: { type: String, select: false },
    // Not required: atozas-auth-kit-express creates email-OTP users without a
    // name, so we derive one from the email in the pre-validate hook below.
    name: { type: String, trim: true, maxlength: 120 },
    avatarUrl: { type: String, default: '' },
    // Profile picture URL as written by atozas-auth-kit-express (Google `picture`).
    picture: { type: String, default: '' },
    // Which mechanism onboarded the account, per atozas-auth-kit-express.
    provider: { type: String, enum: ['email', 'google', 'password'], default: undefined },
    roles: { type: [String], enum: ['user', 'admin'], default: ['user'] },

    // Google Sign-In subject id ("sub"). Sparse so password/OTP users don't collide on null.
    googleId: { type: String, index: true, sparse: true, default: undefined },

    emailVerified: { type: Boolean, default: false },

    // Preferences / settings
    settings: {
      theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
      language: { type: String, default: 'en' },
    },

    // Memory feature (populated in later phases; toggle available now)
    memoryEnabled: { type: Boolean, default: true },

    // Session/security
    refreshTokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date },
    failedLoginCount: { type: Number, default: 0 },
    lockUntil: { type: Date },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * Guarantees a display name. atozas-auth-kit-express onboards email-OTP users
 * with only `{ email, provider }`, so derive a friendly name from the local-part
 * when one is absent (mirrors the legacy auth service behaviour).
 */
userSchema.pre('validate', function deriveName(next) {
  if (!this.name) {
    const local = String(this.email || 'user').split('@')[0] || 'user';
    const cleaned = local.replace(/[._-]+/g, ' ').trim();
    this.name = `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}` || 'User';
  }
  next();
});

userSchema.methods.setPassword = async function setPassword(plain) {
  const rounds = 12;
  this.passwordHash = await bcrypt.hash(plain, rounds);
};

userSchema.methods.verifyPassword = function verifyPassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.methods.isLocked = function isLocked() {
  return Boolean(this.lockUntil && this.lockUntil > new Date());
};

// Never leak the hash or internal counters.
userSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    delete ret.passwordHash;
    delete ret.failedLoginCount;
    delete ret.lockUntil;
    delete ret.refreshTokenVersion;
    return ret;
  },
});

export const User = model('User', userSchema);
export default User;
