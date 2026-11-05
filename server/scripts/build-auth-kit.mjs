/**
 * Installs the prebuilt `atozas-auth-kit-express` bundle.
 *
 * The npm tarball ships TypeScript only, and its exports map points `import`
 * at `./dist/index.js`, which was never published. Compiling that package on
 * the server during `npm ci --omit=dev` does not leave the file behind, so
 * the API crashes on startup.
 *
 * The bundle that Node can load is committed at
 * `vendor/atozas-auth-kit-express/`. This script copies it into the installed
 * package so `import 'atozas-auth-kit-express'` resolves. The auth route also
 * imports the vendored file directly...........
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG = 'atozas-auth-kit-express';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(projectRoot, 'vendor', PKG);
const pkgDir = path.join(projectRoot, 'node_modules', PKG);

const files = [
  ['index.js', path.join('dist', 'index.js')],
  ['index.cjs', path.join('dist', 'index.cjs')],
];

if (!existsSync(path.join(pkgDir, 'package.json'))) {
  console.warn(`[build-auth-kit] ${PKG} is not installed; skipping.`);
  process.exit(0);
}

try {
  for (const [from] of files) {
    const source = path.join(vendorDir, from);
    if (!existsSync(source)) {
      throw new Error(`missing ${path.relative(projectRoot, source)}`);
    }
  }
  for (const [from, to] of files) {
    const target = path.join(pkgDir, to);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(vendorDir, from), target);
  }
  patchEntryPoints(pkgDir);
  const distJs = path.join(pkgDir, 'dist', 'index.js');
  console.log(`[build-auth-kit] ${PKG} is ready (${distJs}).`);
} catch (err) {
  console.error(`[build-auth-kit] Could not prepare ${PKG}: ${err.message}`);
  process.exit(1);
}

function patchEntryPoints(dir) {
  const pkgJsonPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  pkg.type = 'module';
  pkg.main = './dist/index.cjs';
  pkg.module = './dist/index.js';
  delete pkg.types;
  pkg.exports = {
    '.': {
      import: './dist/index.js',
      require: './dist/index.cjs',
      default: './dist/index.js',
    },
  };
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}
