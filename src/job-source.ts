import { promises as fs } from 'node:fs';
import { loadNotionJobs, type NotionConfig } from './notion.js';
import type { QueuedJob } from './types.js';

export async function loadJobQueue(args: Set<string>): Promise<QueuedJob[]> {
  const sourceArg = [...args].find(x => x.startsWith('--source='))?.slice(9);
  if (sourceArg && !['file', 'notion'].includes(sourceArg)) throw new Error('--source must be file or notion');
  if (args.has('--notion') && sourceArg === 'file') throw new Error('--notion conflicts with --source=file');
  const source = args.has('--notion') ? 'notion' : sourceArg ?? 'file';
  const singleUrl = [...args].find(x => x.startsWith('--url='))?.slice(6);
  if (source === 'notion') {
    if (singleUrl !== undefined) throw new Error('Use either --url or --source=notion, not both.');
    let config: NotionConfig;
    try {
      config = JSON.parse(await fs.readFile('config/notion.json', 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Copy config/notion.example.json to config/notion.json and configure the database mapping.');
      throw new Error('Could not read config/notion.json. Check that it contains valid JSON.');
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config/notion.json must be a JSON object.');
    return loadNotionJobs(config, config.token);
  }
  return (singleUrl ?? await fs.readFile('data/jobs.txt', 'utf8')).split(/\r?\n/)
    .map(x => x.trim()).filter(x => x && !x.startsWith('#')).map(url => ({ url }));
}
