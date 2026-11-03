/**
 * Prints the download manifest for every model ATOZAS serves, as JSON.
 *
 * The fetch scripts (deploy/scripts/fetch-models.ps1 and fetch-models.sh) read
 * this instead of carrying their own copy of the catalogue, so adding a model
 * to modelRegistry.js is the only edit needed to make it downloadable.
 *
 *   node scripts/model-manifest.mjs
 *   node scripts/model-manifest.mjs --role chat
 *   node scripts/model-manifest.mjs --format tsv
 *
 * The TSV form exists so the bash installer can read the catalogue with `read`
 * instead of taking a dependency on jq being present on the VPS.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// The registry pulls in config/env.js, whose dotenv.config() resolves against
// the current directory. These scripts are invoked from the repo root and from
// deploy/, so point dotenv at server/.env explicitly rather than relying on cwd.
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const { MODEL_REGISTRY, getModelDownloadUrl } = await import(
  '../src/services/ai/modelRegistry.js'
);

const roleIndex = process.argv.indexOf('--role');
const role = roleIndex !== -1 ? process.argv[roleIndex + 1] : null;

const manifest = MODEL_REGISTRY.filter((m) => !role || m.role === role).map((m) => ({
  id: m.id,
  name: m.name,
  role: m.role,
  file: m.file,
  url: getModelDownloadUrl(m),
  license: m.license,
  licenseNotes: m.licenseNotes || '',
  commercialUse: m.commercialUse,
  sha256: m.sha256 || '',
}));

const formatIndex = process.argv.indexOf('--format');
const format = formatIndex !== -1 ? process.argv[formatIndex + 1] : 'json';

if (format === 'tsv') {
  for (const m of manifest) {
    process.stdout.write(
      [m.id, m.role, m.file, m.url, m.license, m.sha256].join('\t') + '\n',
    );
  }
} else {
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
