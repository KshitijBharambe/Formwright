import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JobResult } from './types.js';

const resultsPath = path.resolve('output/results.jsonl');
async function readResults(): Promise<Map<string, JobResult>> {
  const map = new Map<string, JobResult>();
  try {
    for (const line of (await fs.readFile(resultsPath, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      const item: JobResult = JSON.parse(line);
      map.set(item.url, item);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return map;
}
let writes = Promise.resolve();
function serializeIO<T>(operation: () => Promise<T>): Promise<T> {
  const pending = writes.then(operation);
  writes = pending.then(() => {}, () => {});
  return pending;
}
export async function loadResults(): Promise<Map<string, JobResult>> {
  return serializeIO(readResults);
}
export async function saveResult(result: JobResult): Promise<void> {
  await serializeIO(async () => {
    await fs.mkdir(path.dirname(resultsPath), { recursive: true });
    await fs.appendFile(resultsPath, JSON.stringify(result) + '\n', { mode: 0o600 });
  });
}
export async function writeExceptionQueue(_results?: Map<string, JobResult>): Promise<void> {
  await serializeIO(async () => {
    // Each dashboard attempt has its own map. Build from persisted history so a
    // late worker cannot overwrite exceptions produced by another worker.
    const exceptions = [...(await readResults()).values()].filter(r =>
      ['needs_answers', 'needs_verification', 'error', 'ready_for_review'].includes(r.status));
    await fs.mkdir('output', { recursive: true });
    await fs.writeFile('output/exceptions.json.tmp', JSON.stringify(exceptions, null, 2), { mode: 0o600 });
    await fs.rename('output/exceptions.json.tmp', 'output/exceptions.json');
  });
}
