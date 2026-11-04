/**
 * Builds `atozas-auth-kit-express` in place.
 *
 * The version published to npm ships only TypeScript source and points its
 * package.json at a `dist/` that was never included in the tarball, so a plain
 * `import 'atozas-auth-kit-express'` fails out of the box. This script compiles
 * the package on install and rewrites its entry points to the emitted files.
 *
 * Production `npm ci --omit=dev` has no tsup. npx cannot load the kit's own
 * tsup.config.ts because that file `import`s `tsup` from the kit directory.
 * Compile with a local config that does not import tsup, after ensuring a
 * tsup binary exists next to the kit or the app.
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG = 'atozas-auth-kit-express';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.join(projectRoot, 'node_modules', PKG);
const tsupConfig = path.join(projectRoot, 'scripts', 'auth-kit-tsup.config.mjs');

if (!existsSync(path.join(pkgDir, 'package.json'))) {
  console.warn(`[build-auth-kit] ${PKG} is not installed; skipping.`);
  process.exit(0);
}

try {
  const distJs = path.join(pkgDir, 'dist', 'index.js');
  const distEsm = path.join(pkgDir, 'dist', 'index.mjs');
  if (!existsSync(distEsm) && !existsSync(distJs)) {
    console.log(`[build-auth-kit] Compiling ${PKG} (no dist found)...`);
    compileWithTsup(pkgDir);
  }
  if (!existsSync(distEsm) && !existsSync(distJs)) {
    throw new Error(`${PKG} dist/index.js is still missing after compile`);
  }
  patchEntryPoints(pkgDir);
  console.log(`[build-auth-kit] ${PKG} is ready.`);
} catch (err) {
  console.error(`[build-auth-kit] Could not prepare ${PKG}: ${err.message}`);
  process.exit(1);
}

function tsupBin(root) {
  const unix = path.join(root, 'node_modules', '.bin', 'tsup');
  const win = `${unix}.cmd`;
  if (existsSync(win)) return win;
  if (existsSync(unix)) return unix;
  return '';
}

function compileWithTsup(dir) {
  let bin = tsupBin(projectRoot) || tsupBin(dir);
  if (!bin) {
    console.log('[build-auth-kit] Installing tsup into the auth kit (production install has no compiler)...');
    execSync(
      'npm install --no-save --no-package-lock --no-audit --no-fund tsup@8.5.1 typescript@5.9.3',
      { cwd: dir, stdio: 'inherit' },
    );
    bin = tsupBin(dir);
  }
  if (!bin) {
    throw new Error('tsup is not installed');
  }
  execFileSync(bin, ['--config', tsupConfig, '--no-dts'], {
    cwd: dir,
    stdio: 'inherit',
  });
}

function patchEntryPoints(dir) {
  const pkgJsonPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const hasEsm = existsSync(path.join(dir, 'dist', 'index.mjs'));
  const hasCjs = existsSync(path.join(dir, 'dist', 'index.js'));
  if (hasCjs) pkg.main = './dist/index.js';
  if (hasEsm) pkg.module = './dist/index.mjs';
  pkg.exports = {
    '.': {
      ...(hasEsm ? { import: './dist/index.mjs' } : {}),
      ...(hasCjs ? { require: './dist/index.js', default: './dist/index.js' } : { default: './dist/index.mjs' }),
    },
  };
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}
