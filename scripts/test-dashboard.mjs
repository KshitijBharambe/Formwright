import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';

const dir = await mkdtemp(path.join(tmpdir(), 'formwright-dashboard-'));
const originalCwd = process.cwd(), originalFetch = globalThis.fetch;
process.chdir(dir);
let server;
const until = async predicate => {
  for(let n=0;n<300;n++) { if(await predicate()) return; await new Promise(resolve=>setTimeout(resolve,10)); }
  throw Error('Timed out waiting for worker state');
};
const id = '11111111-1111-1111-1111-111111111111';
const url = n => `https://jobs.example.com/${n}`;
let notionJobs = [{object:'page',id:'page-1',url:'https://notion.so/page-1',last_edited_time:'2026-10-20T12:00:00Z',properties:{URL:{type:'url',url:url('notion')},Name:{type:'title',title:[{plain_text:'Platform Engineer'}]}}}];
let remoteAnswer='Notion answer', notionOffline=false;
const notionConfig={token:'DO-NOT-EXPOSE-THIS-TOKEN',dataSourceId:id,urlProperty:'URL',answerBank:{dataSourceId:id}};
const question='Will you now or in the future require sponsorship?';
globalThis.fetch=async (target, options) => {
  if(String(target)==='http://127.0.0.1:1234/v1/models') return Response.json({data:[{id:'fixture-chat'}]});
  if(!String(target).startsWith('https://api.notion.com/')) return originalFetch(target,options);
  if(notionOffline) throw Error('Offline');
  if(String(target).endsWith('/query')) {
    const body=JSON.parse(options.body);
    return Response.json({results:body.filter?.and ? [{object:'page',properties:{Question:{type:'title',title:[{plain_text:question}]},'Canonical Answer':{type:'rich_text',rich_text:[{plain_text:remoteAnswer}]},Status:{type:'select',select:{name:'Confirmed'}},'Auto-fill OK':{type:'checkbox',checkbox:true}}}] : notionJobs,has_more:false});
  }
  return Response.json({properties:{URL:{type:'url'},Name:{type:'title'},Question:{type:'title'},'Canonical Answer':{type:'rich_text'},Status:{type:'select'},'Auto-fill OK':{type:'checkbox'}}});
};
try {
  await mkdir('config');await mkdir('data');await mkdir('output');
  await writeFile('config/profile.json',JSON.stringify({firstName:'Alex',email:'alex@fixture.test',resumePath:'fixture.pdf'}));
  await writeFile('config/notion.json',JSON.stringify(notionConfig));
  await writeFile('config/answers.json',JSON.stringify({[question]:'Old local answer','Other question?':'Local answer'}));
  await writeFile('data/jobs.txt',url('file')+'\n');
  const { DashboardState }=await import('../dist/dashboard-state.js');
  const { createDashboardServer, startDashboard }=await import('../dist/dashboard.js');
  const { loadAnswerSnapshot }=await import('../dist/answer-source.js');
  const { saveResult }=await import('../dist/storage.js');
  const calls=[];let active=0,maxActive=0,release;
  const processor=async(job,advance,onInputs,autofill)=>{
    active++;maxActive=Math.max(maxActive,active);calls.push({job,advance,autofill});
    onInputs({firstName:'Alex'},await loadAnswerSnapshot());
    if(release) await new Promise(resolve=>{release.resolve=resolve;});
    const result={url:job.url,status:'ready_for_review',timestamp:new Date().toISOString(),message:'Fixture filled',fieldsFilled:['Email']};
    await saveResult(result);active--;return result;
  };
  const state=new DashboardState(processor);await state.init();
  let view=await state.view();
  assert.equal(view.notion.data[0].notion.title,'Platform Engineer');
  assert.equal(view.answers.data.effective[question],'Notion answer');
  assert.deepEqual(view.answers.data.entries.map(row=>row.source),['Notion','Local config']);
  assert.equal(JSON.stringify(view).includes(notionConfig.token),false);
  assert.equal(view.config.data.account.status,'missing_credentials');
  assert.match(view.config.data.account.message,/No shared login credentials.*Configuration/s);
  assert.equal(view.worker.paused,true);
  assert.equal(view.worker.autofill.mode,'deterministic');
  await state.settings(undefined,{mode:'llm',model:'fixture-chat'});
  const added=await state.addUrls(`${url('a')}?utm_source=test\n${url('a')} ${url('b')}`);
  assert.equal(added.added,2);assert.equal((await state.view()).worker.queued,2);assert.equal(calls.length,0);
  await assert.rejects(state.addUrls(`${url('valid')} javascript:bad`));
  assert.equal((await state.view()).applications.some(job=>job.url===url('valid')),false,'Reject the entire invalid batch');
  release={};await state.start();await until(()=>release.resolve);
  await assert.rejects(state.settings(undefined,{mode:'deterministic'}),/current application/);
  await state.pause();release.resolve();release=undefined;
  await until(async()=>!(await state.view()).worker.running);
  assert.equal(calls[0].autofill.mode,'llm');
  assert.equal(calls[0].autofill.model,'fixture-chat');
  assert.equal(calls.length,1,'Pause takes effect after the current job');
  assert.equal((await state.view()).worker.queued,1);
  await state.start();await until(async()=>!(await state.view()).worker.running);
  assert.equal(calls.length,2);assert.equal(maxActive,1,'Never overlap browser workers');
  remoteAnswer='Fresh answer';await state.retry(url('a'));assert.equal(calls.length,2,'Retry stages work without starting it');await state.start();await until(async()=>!(await state.view()).worker.running);
  assert.equal((await state.view()).answers.data.effective[question],'Fresh answer');
  for(const [name,status] of [['submitted','submitted'],['uncertain','needs_verification']])await saveResult({url:url(name),status,timestamp:new Date().toISOString(),message:'Protected',resolvedUrl:url(name+'-employer')});
  await state.addUrls(url('submitted-employer')+' '+url('uncertain-employer'));
  view=await state.view();assert.equal(view.worker.queued,0);
  assert.ok(view.applications.filter(job=>job.url.includes('submitted')||job.url.includes('uncertain')).every(job=>job.retryBlocked));
  // Refetch before selection: a removed Notion job cannot run even if it is visible in an older snapshot.
  notionJobs=[];await state.retry(url('notion'));await state.start();await until(async()=>!(await state.view()).worker.running);
  assert.equal(calls.some(call=>call.job.url===url('notion')),false);
  view=await state.view();assert.match(view.worker.error,/removed, changed/);assert.equal(view.worker.paused,true);
  notionOffline=true;await state.refresh();view=await state.view();assert.match(view.answers.error,/failed/);assert.equal(view.answers.data.effective[question],'Fresh answer','Last successful snapshot is retained with an explicit error');
  notionOffline=false;
  await state.refresh();
  const beforeAll=calls.length;
  const batch=await state.retry();await state.start();await until(async()=>!(await state.view()).worker.running);
  assert.equal(batch.queued,3,'Retry all queues the two manual jobs and the file job');
  assert.ok(batch.skipped>=5,'Protected and no-longer-selected Notion applications are skipped');
  assert.equal(calls.length,beforeAll+3);assert.equal(maxActive,1);
  // A worker setup/input failure pauses the remainder rather than fanning out.
  const failing=new DashboardState(async()=>{throw Error('Answer source unavailable');},'output/failing-state.json');
  await failing.init();await failing.addUrls(url('failure-1')+' '+url('failure-2'));await failing.start();
  await until(async()=>!(await failing.view()).worker.running);
  assert.equal((await failing.view()).worker.paused,true);assert.equal((await failing.view()).worker.queued,1);
  // Saved running work is interrupted on restart; queued work waits for Run queue.
  await state.addUrls(url('restart'));const saved=JSON.parse(await readFile('output/dashboard-state.json','utf8'));
  saved.tasks.push({job:{url:url('interrupted')},state:'running',updatedAt:new Date().toISOString()});await writeFile('output/dashboard-state.json',JSON.stringify(saved));
  const restored=new DashboardState(processor);await restored.init();view=await restored.view();assert.equal(view.worker.paused,true);assert.equal(view.worker.queued,1);assert.equal(view.applications.find(job=>job.url===url('interrupted')).task.state,'interrupted');
  assert.equal(view.worker.autofill.mode,'llm','Mode persists across restart');
  assert.equal(view.worker.autofill.model,'fixture-chat');
  const singleton = await startDashboard(0);
  try { await assert.rejects(startDashboard(0), /Another dashboard/); }
  finally { await singleton.shutdown(); }
  // Exercise the HTTP adapter with an isolated state and an ephemeral port.
  server=createDashboardServer(restored);server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const html=await(await originalFetch(base)).text();const token=html.match(/name="formwright-token" content="([^"]+)"/)[1];
  assert.ok((await originalFetch(base+'/dashboard.js')).headers.get('content-security-policy').includes("script-src 'self'"));
  assert.equal((await originalFetch(base+'/api/state')).status,200);
  const post=(route,body={},headers={})=>originalFetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Formwright-Token':token,...headers},body:JSON.stringify(body)});
  assert.equal((await post('add',{urls:url('http')},{'X-Formwright-Token':''})).status,403);
  assert.equal((await post('add',{urls:url('http')},{Origin:'https://foreign.example'})).status,403);
  assert.equal((await post('add',{urls:url('http')})).status,200);
  assert.equal((await post('add',{urls:'file:///etc/passwd'})).status,400);
  assert.equal((await post('retry',{})).status,400);
  assert.equal((await post('settings',{concurrency:9})).status,400);
  assert.equal((await post('settings',{concurrency:3})).status,200);
  assert.equal((await restored.view()).worker.concurrency,3);
  assert.equal((await post('account',{enabled:true,username:'account@fixture.test',password:'OFFLINE-ACCOUNT-PASSWORD',allowedHosts:['accounts.fixture.test']},{'X-Formwright-Token':''})).status,403);
  const savedAccount=await post('account',{enabled:true,username:'account@fixture.test',password:'OFFLINE-ACCOUNT-PASSWORD',allowedHosts:['accounts.fixture.test']});
  assert.equal(savedAccount.status,200);assert.equal((await savedAccount.text()).includes('OFFLINE-ACCOUNT-PASSWORD'),false);
  assert.equal(JSON.stringify(await restored.view()).includes('OFFLINE-ACCOUNT-PASSWORD'),false);
  assert.equal((await post('account',{enabled:true,allowedHosts:['*']})).status,400);
  assert.equal((await post('settings',{autofill:{mode:'invalid'}})).status,400);
  assert.equal((await post('settings',{autofill:{mode:'deterministic'}})).status,200);
  assert.equal((await restored.view()).worker.autofill.mode,'deterministic');
  assert.equal((await post('lmstudio/check',{autofill:{mode:'llm',model:'fixture-chat'}})).status,200);
  assert.equal((await post('lmstudio/check',{autofill:{baseUrl:'https://remote.example/v1'}})).status,400);
  assert.equal((await post('lmstudio/check',{autofill:{}},{'X-Formwright-Token':''})).status,403);
  const rebinding=await new Promise(resolve=>{request(base+'/api/state',{headers:{Host:'foreign.example'}},response=>{response.resume();resolve(response.statusCode);}).end();});assert.equal(rebinding,403);
  assert.equal(JSON.stringify(await(await originalFetch(base+'/api/state')).json()).includes(notionConfig.token),false);
  // Drive the actual settings view against this local fixture dashboard.
  const { chromium: uiChromium }=await import('playwright');
  const uiBrowser=await uiChromium.launch({headless:true});
  try {
    const page=await uiBrowser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);await page.getByRole('button',{name:'Configuration',exact:true}).click();
    await page.getByText('Shared website account',{exact:true}).click();
    assert.equal(await page.locator('#account-password').inputValue(),'');
    assert.match(await page.locator('#account-state').innerText(),/Automatic sign-in is enabled/);
    await page.locator('#concurrency').fill('2');await page.locator('#concurrency').dispatchEvent('change');
    await page.waitForFunction(()=>document.querySelector('#feedback').textContent==='Autofill settings saved.');
    assert.equal((await restored.view()).worker.concurrency,2);
    await page.locator('#account-username').fill('updated@fixture.test');
    await page.getByRole('button',{name:'Save account settings',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#feedback').textContent.includes('Password stays hidden'));
    assert.equal(await page.locator('#account-password').inputValue(),'');
    assert.equal((await restored.view()).config.data.account.username,'updated@fixture.test');

    await page.getByText('Answer matching & LM Studio',{exact:true}).click();
    await page.locator('#autofill-mode').selectOption('llm');
    await page.locator('#lmstudio-check').click();
    await page.waitForFunction(()=>document.querySelector('#lmstudio-model').value==='fixture-chat');
    assert.match(await page.locator('#lmstudio-status').innerText(),/model/);
    await page.getByRole('button',{name:'Save autofill settings',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#feedback').textContent==='Autofill settings saved.');
    assert.equal((await restored.view()).worker.autofill.mode,'llm');
    assert.equal((await restored.view()).worker.autofill.model,'fixture-chat');
    await page.locator('#autofill-mode').selectOption('deterministic');
    await page.getByRole('button',{name:'Save autofill settings',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#feedback').textContent==='Autofill settings saved.');
    assert.equal((await restored.view()).worker.autofill.mode,'deterministic');
    assert.deepEqual(errors,[],'Dashboard scripts render and mode controls work without runtime errors');
  } finally {await uiBrowser.close();}
  // Exercise the real shared runner offline: retained tabs, current answers, and no submit click.
  await rm('config/notion.json');
  await writeFile('config/profile.json',JSON.stringify({firstName:'Alex',lastName:'Example',fullName:'Alex Example',email:'alex@fixture.test',phone:'5555550100',resumePath:import.meta.filename}));
  const { chromium }=await import('playwright');
  const { runJobs }=await import('../dist/run.js');
  const browser=await chromium.launch({headless:true});
  try {
    const context=await browser.newContext();let unexpected=0;let loadedInputs;
    const fixture='https://boards.greenhouse.io/fixture/jobs/123';
    await context.route('**/*',route=>route.request().url()===fixture ? route.fulfill({contentType:'text/html',body:'<form id="application"><h2>Apply for this job</h2><label for="first_name">First name</label><input id="first_name" required><label for="last_name">Last name</label><input id="last_name" required><label for="email">Email</label><input id="email" type="email" required><label for="motivation">What motivates you about this role?</label><textarea id="motivation" required></textarea><label for="other">Other question?</label><input id="other" required><button type="button" onclick="window.didSubmit=true">Submit application</button></form>'}) : (unexpected++,route.abort()));
    let filled;
    await runJobs(new Set(['--visible','--advance']),{context,jobs:[{url:fixture}],applicationAnswers:{'What motivates you about this role?':'An explicit answer for this application','Other question?':'Must not override approved config'},waitForReview:false,onResult:result=>{filled=result;},onInputs:(_profile,answers)=>{loadedInputs=answers;}});
    assert.equal(filled.status,'ready_for_review');assert.equal(loadedInputs.effective['Other question?'],'Local answer');
    assert.equal(context.pages().length,1,'Shared browser/tab remains open for review');
    assert.equal(await context.pages()[0].locator('#email').inputValue(),'alex@fixture.test');
    assert.equal(await context.pages()[0].locator('#motivation').inputValue(),'An explicit answer for this application');
    assert.equal(await context.pages()[0].locator('#other').inputValue(),'Local answer','Approved config wins over application-specific input');
    assert.equal(await context.pages()[0].evaluate(()=>window.didSubmit||false),false);assert.equal(unexpected,0);
  } finally {await browser.close();}
  console.log('PASS: offline shared runner retains filled browser tabs and never submits.');
  console.log('PASS: durable queue, validation/deduplication, sequential retries, pause/resume, submitted/uncertain protection, fresh answer precedence/provenance, Notion revalidation/errors, restart recovery, local HTTP controls and credential omission.');
} finally {
  globalThis.fetch=originalFetch;
  if(server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  process.chdir(originalCwd);await rm(dir,{recursive:true,force:true});
}
