import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const original = process.cwd();
const dir = await mkdtemp(path.join(tmpdir(), 'formwright-parallel-'));
process.chdir(dir);
const waitUntil = async predicate => { for (let i=0;i<500;i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('Timed out'); };
try {
  await mkdir('config'); await mkdir('data'); await mkdir('output');
  const profile = { firstName: 'Alex', lastName: 'Example', fullName: 'Alex Example', email: 'alex@fixture.test', phone: '+15555550100', resumePath: import.meta.filename };
  await writeFile('config/profile.json', JSON.stringify(profile));
  await writeFile('config/answers.json', '{}'); await writeFile('data/jobs.txt', '');
  const { runConcurrent, validateConcurrency } = await import('../dist/concurrency.js');
  const { DashboardState } = await import('../dist/dashboard-state.js');
  const { saveResult, writeExceptionQueue, loadResults } = await import('../dist/storage.js');
  const { saveAuthSettings, loadAuthSettings } = await import('../dist/auth-settings.js');
  const { runJobs } = await import('../dist/run.js');
  for (const value of [0,9,1.5,'3',NaN]) assert.throws(() => validateConcurrency(value));
  let active=0, peak=0;
  async function* jobs() { for (let i=0;i<30;i++) yield i; }
  await runConcurrent(jobs(), 3, async () => { active++;peak=Math.max(active,peak); await new Promise(resolve=>setTimeout(resolve,5));active--; });
  assert.equal(peak,3);
  let finished=false;
  async function* failing() { yield 1; throw Error('Source failed'); }
  await assert.rejects(runConcurrent(failing(),3,async()=>{await new Promise(resolve=>setTimeout(resolve,10));finished=true;}), /Source failed/);
  assert.equal(finished,true, 'Drain in-flight work before reporting source failure');
  let gates=[], calls=[];
  const state = new DashboardState(async job => {
    calls.push(job.url);
    await new Promise(resolve=>gates.push(resolve));
    const result = {url:job.url,status:'ready_for_review',message:'Filled',timestamp:new Date().toISOString()};
    await saveResult(result); await writeExceptionQueue(new Map([[job.url,result]]));return result;
  });
  await state.init(); await state.settings(undefined,undefined,3);
  const urls=Array.from({length:6},(_,i)=>`https://parallel.fixture.test/${i}`);
  await state.addUrls(urls.join(' ')); await state.start();
  await waitUntil(()=>gates.length===3);
  assert.equal((await state.view()).worker.active.length,3);
  await state.pause(); gates.splice(0).forEach(resolve=>resolve()); await state.waitForIdle();
  assert.equal(calls.length,3); assert.equal((await state.view()).worker.queued,3);
  await state.start(); await waitUntil(()=>gates.length===3);gates.splice(0).forEach(resolve=>resolve());await state.waitForIdle();
  assert.equal(new Set(calls).size,6);
  assert.equal(JSON.parse(await readFile('output/exceptions.json','utf8')).length,6, 'No lost exceptions between workers');
  const restored = new DashboardState(async()=>{}); await restored.init();
  assert.equal((await restored.view()).worker.concurrency,3);assert.equal((await restored.view()).worker.paused,true);
  const account = {enabled:true,allowSignup:true,username:'account@fixture.test',password:'fixture-only-secret!',allowedHosts:['accounts.fixture.test']};
  await saveAuthSettings(account);
  assert.equal((await stat('config/credentials.json')).mode & 0o777, 0o600);
  await saveAuthSettings({...account,password:''});assert.equal((await loadAuthSettings()).password,account.password);
  await restored.refresh();assert.equal(JSON.stringify(await restored.view()).includes(account.password),false);
  await assert.rejects(saveAuthSettings({...account,allowedHosts:['*']}));
  const browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext();
    const sentinel = await context.newPage(); await sentinel.setContent('<h1>Keep this tab</h1>');
    let started=0, release;const barrier=new Promise(resolve=>{release=resolve;});
    const fields='<label>First name<input name="first_name" required></label><label>Last name<input name="last_name" required></label><label>Email<input type="email" name="email" required></label>';
    await context.route('**/*',async route=>{
      started++;if(started===3)release();await barrier;
      const application=`<form><h2>Apply for this job</h2>${fields}<button type="button" id="btn-submit" onclick="window.submitted=true">Submit application</button></form>`;
      const auth = '<h1>Sign in</h1><form><input type="email" required><input type="password" required><button type="button">Sign in</button></form>';
      const body = route.request().url().includes('/0/apply') ? auth+`<script>document.querySelector('button').onclick=()=>{document.body.innerHTML=${JSON.stringify(application)};}</script>` : application;
      return route.fulfill({contentType:'text/html',body});
    });
    await saveAuthSettings({...account,allowedHosts:['accounts.fixture.test','jobs.lever.co']});
    const results=[];
    await runJobs(new Set(['--concurrency=3']),{context,jobs:Array.from({length:6},(_,i)=>({url:`https://jobs.lever.co/parallel/${i}/apply`})),onResult:result=>results.push(result)});
    assert.equal(JSON.stringify(results).includes(account.password),false);
    assert.equal(results.length,6);assert.ok(results.every(result=>result.status==='ready_for_review'));
    assert.equal(context.pages().length,1,'Only each worker’s own pages are closed');assert.equal(sentinel.isClosed(),false);
    assert.ok(results.every(result=>result.fieldsFilled.some(label=>/email/i.test(label))));
    assert.equal((await loadResults()).size,12);
    assert.equal(JSON.parse(await readFile('output/exceptions.json','utf8')).length,12);
  } finally { await browser.close(); }
  console.log('PASS: bounded overlap, pause/resume, draining on source failure, persistence, write-only credentials, concurrent result storage and full parallel autofill.');
} finally { process.chdir(original);await rm(dir,{recursive:true,force:true}); }
