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
 * tsup binary exists next to the kit or the app....
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

function tsupCli(root) {
  const cli = path.join(root, 'node_modules', 'tsup', 'dist', 'cli-default.js');
  return existsSync(cli) ? cli : '';
}

function compileWithTsup(dir) {
  let cli = tsupCli(projectRoot) || tsupCli(dir);
  if (!cli) {
    console.log('[build-auth-kit] Installing tsup into the auth kit (production install has no compiler)...');
    execSync(
      'npm install --prefix . --no-save --no-package-lock --no-audit --no-fund tsup@8.5.1 typescript@5.9.3',
      { cwd: dir, stdio: 'inherit' },
    );
    // npm hoists out of a package that already lives under node_modules,
    // so the binary may land in the app root rather than the kit.
    cli = tsupCli(dir) || tsupCli(projectRoot);
  }
  if (!cli) {
    throw new Error('tsup is not installed');
  }
  execFileSync(process.execPath, [cli, '--config', tsupConfig, '--no-dts'], {
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
