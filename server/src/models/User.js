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
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    avatarUrl: { type: String, default: '' },
    roles: { type: [String], enum: ['user', 'admin'], default: ['user'] },

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
