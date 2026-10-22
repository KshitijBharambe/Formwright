import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadNotionAnswers } from '../dist/notion.js';
import { loadAnswers } from '../dist/answer-source.js';
import { getAnswer } from '../dist/answers.js';
import { fieldAnswer } from '../dist/profile-values.js';
const id = '11111111-1111-1111-1111-111111111111';
const schema = { properties: { Question: { type: 'title' }, 'Canonical Answer': { type: 'rich_text' }, 'Auto-fill OK': { type: 'checkbox' }, Status: { type: 'select' } } };
const text = (type, value) => ({ type, [type]: [{ plain_text: value }] });
const row = (q, a, status = 'Confirmed', ok = true, extra = {}) => ({ object: 'page', properties: {
  Question: text('title', q), 'Canonical Answer': text('rich_text', a), 'Short Answer': text('rich_text', 'STALE SHORT ANSWER'),
  Status: { type: 'select', select: { name: status } }, 'Auto-fill OK': { type: 'checkbox', checkbox: ok }
}, ...extra });
function mock(replies) {
  const calls = [];
  return { calls, fetch: async (url, opts) => {
    assert.equal(opts.headers.Authorization, 'Bearer secret');
    calls.push({ url, ...opts, body: opts.body && JSON.parse(opts.body) });
    assert.ok(replies.length, `Unexpected request ${url}`);
    const value = replies.shift();
    return value instanceof Response ? value : Response.json(value);
  }, sleep: async () => {} };
}
const question = 'Are you legally authorized to work in the United States?';
const answer = 'Yes. I am currently authorized under F-1 STEM OPT.';
let client = mock([schema, { results: [
  row(question, answer), row('Prior application?', 'Check the tracker.', 'Dynamic auto-fill'),
  row('Unconfirmed?', 'No', 'Needs one-time confirmation'), row('Manual?', 'No', 'Sensitive / manual'),
  row('Custom?', 'CUSTOMIZE FOR EACH APPLICATION.', 'Custom response'), row('Unchecked?', 'Yes', 'Confirmed', false),
  row('Empty?', ''), row('Placeholder?', 'REPLACE_WITH_ANSWER'), row('Pronouns?', 'skip'),
  row('Archived?', 'Yes', 'Confirmed', true, { archived: true }), row('Trashed?', 'Yes', 'Confirmed', true, { in_trash: true }),
  row('Conflict?', 'Yes'), row('Identical?', 'Value')
], has_more: true, next_cursor: 'next' }, { results: [row('CONFLICT!', 'No'), row('IDENTICAL!', 'Value'), row('Email?', 'test@example.com')], has_more: false }]);
const bank = await loadNotionAnswers({ dataSourceId: id }, 'secret', client);
assert.deepEqual({ ...bank }, { [question]: answer, 'Identical?': 'Value', 'Email?': 'test@example.com' });
assert.equal(client.calls[2].body.start_cursor, 'next');
assert.deepEqual(client.calls[1].body.filter.and[0], { property: 'Auto-fill OK', checkbox: { equals: true } });
assert.equal(getAnswer(question.toUpperCase().replace('?', '!'), {}, bank), answer);
for (const kind of ['radio', 'select', 'combobox', 'checkbox']) {
  assert.equal(fieldAnswer({ label: question, kind }, {}, bank), 'Yes');
}
assert.equal(fieldAnswer({ label: question, kind: 'textarea' }, {}, bank), answer);
assert.equal(fieldAnswer({ label: 'Unknown?', kind: 'text' }, {}, bank), undefined);
await assert.rejects(loadNotionAnswers({ dataSourceId: id }, undefined), /token/);
await assert.rejects(loadNotionAnswers({ dataSourceId: 'bad' }, 'secret'), /UUID/);
await assert.rejects(loadNotionAnswers({ dataSourceId: id }, 'secret', mock([{ properties: {} }])), /property/);
await assert.rejects(loadNotionAnswers({ dataSourceId: id }, 'secret', mock([schema, { results: [], has_more: true, next_cursor: 'a' }, { results: [], has_more: true, next_cursor: 'a' }])), /pagination/);
await assert.rejects(loadNotionAnswers({ dataSourceId: id }, 'secret', mock([schema, { results: null }])), /invalid results/);
await assert.rejects(loadNotionAnswers({ dataSourceId: id }, 'secret', mock([new Response('secret', { status: 403 })])), /HTTP 403/);
const oldCwd = process.cwd(), originalFetch = globalThis.fetch;
const dir = await mkdtemp(path.join(tmpdir(), 'formwright-answers-'));
try {
  process.chdir(dir); await mkdir('config');
  assert.deepEqual(await loadAnswers(), {});
  await writeFile('config/answers.json', JSON.stringify({ [question.toLowerCase()]: 'Local outdated answer', 'Other?': 'Local value' }));
  assert.equal((await loadAnswers())['Other?'], 'Local value');
  await writeFile('config/notion.json', JSON.stringify({ token: 'secret', answerBank: { dataSourceId: id } }));
  globalThis.fetch = mock([schema, { results: [row(question, answer)], has_more: false }]).fetch;
  let merged = await loadAnswers();
  assert.equal(merged[question], answer); assert.equal(merged[question.toLowerCase()], undefined);
  assert.equal(merged['Other?'], 'Local value');
  // Fresh load must see changed Notion values, not a cached snapshot.
  globalThis.fetch = mock([schema, { results: [row(question, 'No')], has_more: false }]).fetch;
  assert.equal((await loadAnswers())[question], 'No');
  // Notion remains authoritative even when local and visible question wording differ.
  await writeFile('config/answers.json', JSON.stringify({ 'Degree type': 'Master of Arts' }));
  globalThis.fetch = mock([schema, { results: [row('Academic degree', 'Master of Science')], has_more: false }]).fetch;
  merged = await loadAnswers();
  assert.equal(merged['Degree type'], undefined);
  assert.equal(getAnswer('Type of degree *', {}, merged), 'Master of Science');
  globalThis.fetch = mock([new Response('private', { status: 403 })]).fetch;
  await assert.rejects(loadAnswers(), /HTTP 403/);
  await writeFile('config/notion.json', JSON.stringify({ token: 'secret', answerBank: {} }));
  await assert.rejects(loadAnswers(), /answerBank.dataSourceId/);
  await writeFile('config/answers.json', JSON.stringify({ Bad: 42 }));
  await assert.rejects(loadAnswers(), /answer strings/);
} finally { process.chdir(oldCwd); globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true }); }
console.log('Notion Answer Bank tests passed (approval gates, pagination, matching, refresh, errors).');
