/**
 * Builds `atozas-auth-kit-express` in place.
 *
 * The npm tarball ships TypeScript only. Its exports map still points
 * `import` at `./dist/index.js`, which was never published, so Node throws
 * ERR_MODULE_NOT_FOUND the first time auth routes load.
 *
 * `npm ci --omit=dev` does not install tsup, and installing it under the kit
 * gets dropped because the parent sets npm_config_omit=dev. Compile with
 * esbuild from a temp project, and write the exact files the exports map
 * loads: ESM `dist/index.js` and CJS `dist/index.cjs`.
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG = 'atozas-auth-kit-express';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.join(projectRoot, 'node_modules', PKG);

if (!existsSync(path.join(pkgDir, 'package.json'))) {
  console.warn(`[build-auth-kit] ${PKG} is not installed; skipping.`);
  process.exit(0);
}

try {
  const entry = path.join(pkgDir, 'src', 'index.ts');
  const distJs = path.join(pkgDir, 'dist', 'index.js');
  if (!existsSync(entry)) {
    throw new Error(`${PKG} has no src/index.ts to compile`);
  }
  if (!isLoadableEsm(distJs)) {
    console.log(`[build-auth-kit] Compiling ${PKG} -> dist/index.js`);
    compileWithEsbuild(pkgDir);
  }
  if (!isLoadableEsm(distJs)) {
    throw new Error(`${PKG} dist/index.js is still missing after compile`);
  }
  patchEntryPoints(pkgDir);
  console.log(`[build-auth-kit] ${PKG} is ready (${distJs}).`);
} catch (err) {
  console.error(`[build-auth-kit] Could not prepare ${PKG}: ${err.message}`);
  process.exit(1);
}

function isLoadableEsm(file) {
  if (!existsSync(file)) return false;
  const source = readFileSync(file, 'utf8');
  return source.includes('export') && source.includes('createAuthRouter');
}

function compileWithEsbuild(dir) {
  const tools = path.join(tmpdir(), 'atozas-auth-kit-tools');
  mkdirSync(tools, { recursive: true });
  writeFileSync(
    path.join(tools, 'package.json'),
    `${JSON.stringify({ private: true, dependencies: { esbuild: '0.25.11' } })}\n`,
  );
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_omit/i.test(key) || key === 'npm_config_production') delete env[key];
  }
  console.log(`[build-auth-kit] Installing esbuild in ${tools}`);
  execSync('npm install --no-audit --no-fund --no-package-lock', {
    cwd: tools,
    stdio: 'inherit',
    env,
  });

  const runner = path.join(tools, 'build-kit.mjs');
  writeFileSync(
    runner,
    `import * as esbuild from 'esbuild';
import path from 'node:path';

const dir = process.argv[2];
const entry = path.join(dir, 'src', 'index.ts');
const shared = {
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  target: 'node18',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
};
await esbuild.build({ ...shared, format: 'esm', outfile: path.join(dir, 'dist', 'index.js') });
await esbuild.build({ ...shared, format: 'cjs', outfile: path.join(dir, 'dist', 'index.cjs') });
`,
  );
  execFileSync(process.execPath, [runner, dir], {
    cwd: tools,
    stdio: 'inherit',
    env,
  });
}

function patchEntryPoints(dir) {
  const pkgJsonPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const esm = './dist/index.js';
  const cjs = './dist/index.cjs';
  // Without this, Node parses dist/index.js as CommonJS and rejects `export`.
  pkg.type = 'module';
  pkg.main = cjs;
  pkg.module = esm;
  delete pkg.types;
  pkg.exports = {
    '.': {
      import: esm,
      require: cjs,
      default: esm,
    },
  };
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}
