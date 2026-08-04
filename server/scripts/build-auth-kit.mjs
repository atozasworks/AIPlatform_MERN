/**
 * Builds `atozas-auth-kit-express` in place.
 *
 * The version published to npm ships only TypeScript source and points its
 * package.json at a `dist/` that was never included in the tarball, so a plain
 * `import 'atozas-auth-kit-express'` fails out of the box. This script compiles
 * the package with its own tsup config on install and rewrites its entry points
 * to the emitted files (tsup names the CJS bundle `index.js` and the ESM bundle
 * `index.mjs`, which the shipped `exports` map does not match).
 *
 * It is intentionally best-effort: a failure here logs a warning instead of
 * breaking `npm install`, and the build is skipped when the dist already exists.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG = 'atozas-auth-kit-express';
// Resolve the install dir directly: the package's `exports` map omits
// `./package.json`, so `require.resolve` cannot be used before it is fixed.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.join(projectRoot, 'node_modules', PKG);

if (!existsSync(path.join(pkgDir, 'package.json'))) {
  console.warn(`[build-auth-kit] ${PKG} is not installed; skipping.`);
  process.exit(0);
}

try {
  const distEsm = path.join(pkgDir, 'dist', 'index.mjs');
  if (!existsSync(distEsm)) {
    console.log(`[build-auth-kit] Compiling ${PKG} (no dist found)...`);
    execSync('npx --yes tsup', { cwd: pkgDir, stdio: 'inherit' });
  }
  patchEntryPoints(pkgDir);
  console.log(`[build-auth-kit] ${PKG} is ready.`);
} catch (err) {
  console.warn(`[build-auth-kit] Could not prepare ${PKG}: ${err.message}`);
}

function patchEntryPoints(dir) {
  const pkgJsonPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  pkg.main = './dist/index.js';
  pkg.module = './dist/index.mjs';
  pkg.exports = {
    '.': {
      types: './dist/index.d.ts',
      import: './dist/index.mjs',
      require: './dist/index.js',
    },
  };
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}
