/**
 * Creates or updates an administrator account with an email + password, so the
 * admin panel (/admin) has something to sign in with. The rest of the app is
 * passwordless (OTP / Google / SSO); this is the one place a password is set.
 *
 * Usage (from the server/ directory):
 *
 *   node scripts/create-admin.mjs --email admin@atozasai.com --password 'S3cret!'
 *
 * Or via environment variables (useful in CI / provisioning):
 *
 *   ADMIN_EMAIL=admin@atozasai.com ADMIN_PASSWORD='S3cret!' node scripts/create-admin.mjs
 *
 * If the user already exists it is granted the 'admin' role and its password is
 * reset to the provided value. Existing sessions are invalidated by bumping the
 * refresh-token version.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

// Scripts run from server/ and from the repo root; point dotenv at server/.env
// explicitly rather than relying on the current working directory.
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const { User } = await import('../src/models/User.js');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const email = (arg('email') || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const password = arg('password') || process.env.ADMIN_PASSWORD || '';
const name = arg('name') || process.env.ADMIN_NAME || '';

if (!email || !password) {
  console.error(
    'Usage: node scripts/create-admin.mjs --email <email> --password <password> [--name <name>]\n' +
      '   or: ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/create-admin.mjs',
  );
  process.exit(1);
}

if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aichat';

async function main() {
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 });

  let user = await User.findOne({ email }).select('+passwordHash');
  const isNew = !user;

  if (!user) {
    user = new User({ email, provider: 'password', emailVerified: true });
  }

  if (name) user.name = name;
  if (!user.roles?.includes('admin')) {
    user.roles = [...new Set([...(user.roles || ['user']), 'admin'])];
  }
  await user.setPassword(password);
  // If the account was OTP/Google-only, record that it now also has a password.
  if (!user.provider) user.provider = 'password';
  user.deletedAt = null;
  user.failedLoginCount = 0;
  user.lockUntil = undefined;
  // Invalidate any existing sessions so the new password takes full effect.
  user.refreshTokenVersion = (user.refreshTokenVersion || 0) + 1;

  await user.save();

  console.log(
    `${isNew ? 'Created' : 'Updated'} admin account:\n` +
      `  email: ${user.email}\n` +
      `  roles: ${user.roles.join(', ')}\n` +
      '\nYou can now sign in at /admin with this email and password.',
  );
}

main()
  .catch((err) => {
    console.error('Failed to create admin:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
  });
