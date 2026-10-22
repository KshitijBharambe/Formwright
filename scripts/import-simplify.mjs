// Read packaged JSON only. Extension scripts, cookies, and services are never loaded.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const source = process.argv[2];
if (!source) throw new Error('Usage: npm run import:simplify -- /absolute/path/to/extension/version');
const bytes = await readFile(path.join(source, 'remoteConfig.json'));
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
const config = JSON.parse(bytes.toString('utf8'));
if (!config.ATS || typeof config.ATS !== 'object') throw new Error('Missing ATS configuration');
const properties = ['urls', 'helpMessageUrls', 'urlsExcluded', 'embeddedPaths', 'pathsExcluded', 'containerPath',
  'containerRequired', 'inputSelectors', 'trackedInputSelectors', 'applyButtonPaths',
  'applyOptionPaths', 'continueButtonPaths', 'submitButtonPaths', 'submittedSuccessPaths'];
const ats = {};
for (const [key, value] of Object.entries(config.ATS)) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
  if (!Array.isArray(value.inputSelectors) && !Array.isArray(value.trackedInputSelectors)) continue;
  ats[key] = Object.fromEntries(properties.filter(k => k in value).map(k => [k, value[k]]));
}
const output = {
  schemaVersion: 1,
  provenance: { name: manifest.name, version: manifest.version,
    configSha256: createHash('sha256').update(bytes).digest('hex'),
    importedAt: new Date().toISOString(),
    note: 'Local extracted compatibility data. Runtime implements detection and metadata only; action programs are not executed.' },
  ats
};
await mkdir('config', { recursive: true });
await writeFile('config/simplify-rules.json', JSON.stringify(output));
console.log(`Imported ${Object.keys(ats).length} ATS rule sets from Simplify ${manifest.version}.`);
