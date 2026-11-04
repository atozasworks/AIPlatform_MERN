/**
 * Builds `atozas-react-auth-kit` in place.
 *
 * Like its Express counterpart, the published npm package contains only
 * TypeScript source while its package.json points at a `dist/` that was never
 * published, so Vite cannot resolve `atozas-react-auth-kit` or its stylesheet.
 * This script compiles the package with its own tsup config on install and
 * rewrites the entry points to the emitted `index.mjs` / `index.js` bundles.
 *
 * Best-effort: failures log a warning rather than breaking `npm install`, and
 * the build is skipped when the dist already exists.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG = 'atozas-react-auth-kit';
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
    './styles.css': './dist/styles.css',
  };
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}
