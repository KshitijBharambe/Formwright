/**
 * Guard against accidentally executing Playwright evaluate() callbacks via an
 * esbuild/tsx transform, which may inject `__name` into browser-only closures.
 * This is a build smoke check, NOT a live browser/application test.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

async function jsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await jsFiles(file));
    else if (entry.isFile() && entry.name.endsWith('.js')) found.push(file);
  }
  return found;
}

const files = await jsFiles('dist');
if (!files.length) throw new Error('Compiled files not found. Run npm run build first.');
const evaluationModules = ['form.js', 'form-detection.js', 'verification.js'];
const foundModules = new Set();
for (const file of files) {
  const source = await readFile(file, 'utf8');
  if (evaluationModules.includes(path.basename(file))) foundModules.add(path.basename(file));
  if (/\b__name\b/.test(source)) {
    throw new Error(`${file} contains an esbuild __name helper. Do not run with tsx; build with tsc.`);
  }
}
for (const expected of evaluationModules) {
  if (!foundModules.has(expected)) throw new Error(`Expected compiled module ${expected} is missing.`);
}
console.log('PASS: compiled Playwright callback modules contain no injected __name helper.');
