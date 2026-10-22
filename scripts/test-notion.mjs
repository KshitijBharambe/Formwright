import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNotionJobs } from '../dist/notion.js';
import { loadJobQueue } from '../dist/job-source.js';
const id = '11111111-1111-1111-1111-111111111111';
const compact = id.replaceAll('-', '');
const config = { dataSourceId: id, urlProperty: 'Job URL', companyProperty: 'Company',
  filter: { property: 'Status', status: { equals: 'Apply' } }, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] };
const schema = { properties: { 'Job URL': { type: 'url' }, Company: { type: 'rich_text' } } };
const text = value => [{ plain_text: value }];
const page = (n, url, extra = {}) => ({ object: 'page', id: `page-${n}`, url: `https://notion.so/page-${n}`,
  properties: { 'Job URL': { type: 'url', url }, Name: { type: 'title', title: text(`Role ${n}`) }, Company: { type: 'rich_text', rich_text: text('Acme') } }, ...extra });
function mock(replies) {
  const calls = [];
  return { calls, fetch: async (url, options) => {
    calls.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
    assert.equal(options.headers.Authorization, 'Bearer secret');
    assert.equal(options.headers['Notion-Version'], '2025-09-03');
    assert.ok(url.startsWith('https://api.notion.com/v1/'));
    assert.ok(replies.length, `Unexpected call: ${url}`);
    const value = replies.shift();
    return value instanceof Response ? value : Response.json(value);
  }, sleep: async () => {}, warn: () => {} };
}
let client = mock([schema,
  { results: [page(1, 'https://jobs.example.com/1?utm_source=test'), page(2, 'javascript:alert(1)'), page(3, 'https://example.com/3', { archived: true })], has_more: true, next_cursor: 'next' },
  { results: [page(4, 'https://jobs.example.com/1'), page(5, 'https://jobs.example.com/2'), page(6, 'https://user:pass@example.com')], has_more: false }]);
const jobs = await loadNotionJobs(config, 'secret', client);
assert.equal(jobs.length, 2);
assert.equal(jobs[0].notion.pageId, 'page-1');
assert.equal(jobs[0].notion.title, 'Role 1');
assert.equal(jobs[0].notion.company, 'Acme');
assert.equal(client.calls[2].body.start_cursor, 'next');
assert.deepEqual(client.calls[1].body.filter, config.filter);
assert.deepEqual(client.calls[1].body.sorts[0], { timestamp: 'last_edited_time', direction: 'descending' }, 'Latest updates must take precedence over older configured sorts');
assert.deepEqual(client.calls[1].body.sorts[1], { timestamp: 'created_time', direction: 'descending' }, 'Newer additions win timestamp ties');
assert.equal(client.calls[1].url, `https://api.notion.com/v1/data_sources/${compact}/query`);
client = mock([{ data_sources: [{ id }] }, schema, { results: [], has_more: false }]);
assert.deepEqual(await loadNotionJobs({ ...config, dataSourceId: undefined, databaseId: id }, 'secret', client), []);
assert.ok(client.calls[0].url.includes('/databases/'));
await assert.rejects(loadNotionJobs(config, undefined), /Set token in config/);
await assert.rejects(loadNotionJobs({ ...config, dataSourceId: 'https://notion.so/view' }, 'secret'), /UUID/);
await assert.rejects(loadNotionJobs({ ...config, urlProperty: 'Missing' }, 'secret', mock([schema])), /must exist/);
await assert.rejects(loadNotionJobs({ ...config, dataSourceId: undefined, databaseId: id }, 'secret', mock([{ data_sources: [{ id }, { id }] }])), /multiple/);
for (const status of [400, 401, 403, 404]) {
  await assert.rejects(loadNotionJobs(config, 'secret', mock([new Response('private error with secret', { status })])), new RegExp(`HTTP ${status}`));
}
client = mock([new Response('', { status: 429, headers: { 'Retry-After': '1' } }), schema, { results: [], has_more: false }]);
const delays = []; client.sleep = async ms => delays.push(ms);
await loadNotionJobs(config, 'secret', client);
assert.deepEqual(delays, [1000]);
await assert.rejects(loadNotionJobs(config, 'secret', mock(Array.from({ length: 4 }, () => new Response('', { status: 503 })))), /HTTP 503/);
await assert.rejects(loadNotionJobs(config, 'secret', { fetch: async () => { throw Error('secret'); } }), /request failed/);
await assert.rejects(loadNotionJobs(config, 'secret', mock([schema, { results: [], has_more: true, next_cursor: 'same' }, { results: [], has_more: true, next_cursor: 'same' }])), /pagination/);
for (const property of [{ type: 'rich_text', rich_text: text('https://example.com/job') }, { type: 'formula', formula: { type: 'string', string: 'https://example.com/job' } }]) {
  const row = page(1, ''); row.properties['Job URL'] = property;
  const selected = await loadNotionJobs(config, 'secret', mock([schema, { results: [row], has_more: false }]));
  assert.equal(selected[0].url, 'https://example.com/job');
}
await assert.rejects(loadJobQueue(new Set(['--source=bad'])), /source must/);
await assert.rejects(loadJobQueue(new Set(['--notion', '--url=https://example.com'])), /either/);
await assert.rejects(loadJobQueue(new Set(['--notion', '--source=file'])), /conflicts/);
const oldCwd = process.cwd();
const dir = await mkdtemp(path.join(tmpdir(), 'formwright-notion-'));
try {
  process.chdir(dir);
  await assert.rejects(loadJobQueue(new Set(['--notion'])), /Copy config/);
  await mkdir('config'); await mkdir('data');
  await writeFile('data/jobs.txt', '# comment\nhttps://example.com/one\n\nhttps://example.com/two\n');
  assert.equal((await loadJobQueue(new Set())).length, 2);
  assert.deepEqual(await loadJobQueue(new Set(['--url=https://example.com/single'])), [{ url: 'https://example.com/single' }]);
  const runner = fileURLToPath(new URL('../dist/run.js', import.meta.url));
  const listed = JSON.parse(execFileSync(process.execPath, [runner, '--list-jobs', '--limit=1'], { cwd: dir, encoding: 'utf8' }));
  assert.deepEqual(listed, [{ url: 'https://example.com/one' }]); // no profile or browser needed
  await writeFile('config/notion.json', '{broken');
  await assert.rejects(loadJobQueue(new Set(['--notion'])), /valid JSON/);
  await writeFile('config/notion.json', 'null');
  await assert.rejects(loadJobQueue(new Set(['--notion'])), /JSON object/);
  await writeFile('config/notion.json', JSON.stringify(config));
  await assert.rejects(loadJobQueue(new Set(['--notion'])), /Set token in config/);
  await writeFile('config/notion.json', JSON.stringify({ ...config, token: 42 }));
  await assert.rejects(loadJobQueue(new Set(['--notion'])), /Set token in config/);
  await writeFile('config/notion.json', JSON.stringify({ ...config, token: 'secret' }));
  const originalFetch = globalThis.fetch;
  const savedEnv = Object.fromEntries(['NOTION_TOKEN', 'NOTION_DATABASE_ID', 'NOTION_DATA_SOURCE_ID'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(savedEnv)) process.env[key] = 'must-not-be-used';
  try {
    client = mock([schema, { results: [page(1, 'https://example.com/live')], has_more: false }]);
    globalThis.fetch = client.fetch;
    const selected = await loadJobQueue(new Set(['--notion']));
    assert.ok(!JSON.stringify(selected).includes('secret'));
    assert.ok(!('token' in selected[0]));
    assert.equal(selected[0].notion.pageId, 'page-1');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
} finally { process.chdir(oldCwd); await rm(dir, { recursive: true, force: true }); }
console.log('Notion queue tests passed (mocked API; no live database changes).');
