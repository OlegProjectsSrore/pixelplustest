import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { library, validateLibrary, compileVoiceBlocks, validateLibraryManifest } from '../worker/src/audit/library.ts';
import { runtimeStateSchema, runtimeResultSchema } from '../worker/src/audit/runtime-schemas.ts';
import { initialAuditState } from '../worker/src/audit/contracts.ts';
import { analyzeAudit } from '../worker/src/audit/engine.ts';
import { validateSchema } from './audit-schema.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = path.join(root, 'worker/src/audit/data');
const outDir = path.join(root, '.artifacts/audit-assets');
const production = process.argv.includes('--production');
const checkOnly = process.argv.includes('--check');
const filenames = (await readdir(dataDir)).filter(name => name.endsWith('.json') && name !== 'library-manifest.json').sort();
const files = {};
for (const filename of filenames) {
  const bytes = await readFile(path.join(dataDir, filename));
  JSON.parse(bytes.toString('utf8'));
  files[filename] = bytes;
}
let ruleChecks;
try { ruleChecks = JSON.parse(await readFile(path.join(dataDir, 'rule-checks.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const report = validateLibrary(library, { ruleChecks });
const schemaState = initialAuditState(library.version, 'chat', 0);
const schemaSnapshot = { id: 'build-contract-check', session_id: 'build-contract-check', library_version: library.version,
  created_at: 0, through_seq: 0, answers: [], state: schemaState, limitations: [] };
report.errors.push(...validateSchema(schemaState, runtimeStateSchema),
  ...validateSchema(analyzeAudit(schemaSnapshot, library, { allowDraft: true }), runtimeResultSchema));
const manifest = { library_version: library.version, rules_version: library.rulesVersion, status: library.status,
  files: filenames.map(filename => ({ path: filename, sha256: createHash('sha256').update(files[filename]).digest('hex') })) };
report.errors.push(...await validateLibraryManifest(manifest, files));
// A source manifest, when present, must verify the exact source bytes too.
try {
  const sourceManifest = JSON.parse(await readFile(path.join(dataDir, 'library-manifest.json'), 'utf8'));
  const entries = sourceManifest.files.map(item => ({ path: item.path ?? item.name, sha256: item.sha256 }));
  const declared = Object.fromEntries(entries.filter(item => Object.hasOwn(files, item.path)).map(item => [item.path, files[item.path]]));
  report.errors.push(...await validateLibraryManifest({ ...sourceManifest, files: entries }, declared));
  const loader = await readFile(path.join(root, 'worker/src/audit/library.ts'), 'utf8');
  for (const match of loader.matchAll(/from '\.\/data\/([^']+)'/g)) {
    if (!entries.some(item => item.path === match[1])) report.errors.push(`Runtime input absent from source manifest: ${match[1]}`);
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if (production && !report.productionReady) report.errors.push('Production release requires an approved library and matching runtime schemas.');
try {
  const previous = JSON.parse(await readFile(path.join(outDir, 'library-manifest.json'), 'utf8'));
  if (production && previous.library_version === manifest.library_version && JSON.stringify(previous.files) !== JSON.stringify(manifest.files)) report.errors.push('Published library content changed without a new version.');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const bytes = Object.values(files).reduce((sum, value) => sum + value.byteLength, 0);
console.log(JSON.stringify({ ...report, library_version: library.version, source_bytes: bytes }, null, 2));
if (report.errors.length) process.exitCode = 1;
else if (!checkOnly) {
  await mkdir(outDir, { recursive: true });
  const voice = compileVoiceBlocks(library, { allowDraft: !production });
  await writeFile(path.join(outDir, 'library-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(outDir, 'voice-blocks.json'), JSON.stringify(voice) + '\n');
  await writeFile(path.join(outDir, 'worker-state.schema.json'), JSON.stringify(runtimeStateSchema, null, 2) + '\n');
  await writeFile(path.join(outDir, 'worker-result.schema.json'), JSON.stringify(runtimeResultSchema, null, 2) + '\n');
  const index = JSON.parse(await readFile(path.join(root, 'knowledge-base/search-index.json'), 'utf8'));
  await writeFile(path.join(outDir, 'knowledge-stats.json'), JSON.stringify({ index_bytes: (await readFile(path.join(root, 'knowledge-base/search-index.json'))).byteLength,
    corpus: index.corpus, documents: index.docs.length, chunks: index.chunks.length,
    top_level_fields: Object.keys(index), library_source_bytes: bytes, counts: report.counts }, null, 2) + '\n');
}
