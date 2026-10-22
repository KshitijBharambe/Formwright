import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';

const dir=await mkdtemp(path.join(tmpdir(),'formwright-workspace-')),cwd=process.cwd(),originalFetch=globalThis.fetch;
const source='11111111-1111-1111-1111-111111111111',pageId=n=>`22222222-2222-2222-2222-${String(n).padStart(12,'0')}`;
const schema={properties:{URL:{type:'url'},Job:{type:'title'},Company:{type:'rich_text'},Status:{type:'select',select:{options:['New','Apply','Applied','Rejected','Closed'].map(name=>({name}))}},Lifecycle:{type:'select',select:{options:['Active','Archived'].map(name=>({name}))}}}};
const makeJob=(n,company,title)=>({object:'page',id:pageId(n),parent:{data_source_id:source},url:'https://notion.so/'+pageId(n),properties:{URL:{type:'url',url:`https://jobs.fixture.test/${n}`},Job:{type:'title',title:[{plain_text:title}]},Company:{type:'rich_text',rich_text:[{plain_text:company}]},Status:{type:'select',select:{name:'New'}},Lifecycle:{type:'select',select:{name:'Active'}}}});
const pages=[makeJob(1,'Zebra','Backend Engineer'),makeJob(2,'Acme','Platform Engineer'),makeJob(3,'Acme','API Engineer'),makeJob(4,'Maple','Engineer')];
let patchCount=0,failPatch=false,ignorePatch=false,notionOffline=false;
globalThis.fetch=async (target,options={})=>{
  if(!String(target).startsWith('https://api.notion.com/'))return originalFetch(target,options);
  if(notionOffline)throw Error('offline');
  if(String(target).endsWith('/query'))return Response.json({results:pages.filter(page=>!JSON.parse(options.body).filter || (['New','Apply'].includes(page.properties.Status.select.name)&&page.properties.Lifecycle.select.name==='Active')),has_more:false});
  if(String(target).includes('/pages/')){
    const id=String(target).split('/').at(-1).replaceAll('-',''),page=pages.find(page=>page.id.replaceAll('-','')===id);
    assert.ok(page,'Only known fixture pages can be written');
    if(options.method==='PATCH'){
      patchCount++;if(failPatch)return new Response('',{status:403});
      if(!ignorePatch){const body=JSON.parse(options.body);assert.deepEqual(Object.keys(body),['properties']);Object.assign(page.properties,structuredClone(body.properties));}
    }
    return Response.json(structuredClone(page));
  }
  return Response.json(schema);
};
process.chdir(dir);
let server,browser;
try {
  const { DashboardState }=await import('../dist/dashboard-state.js');
  const { createDashboardServer }=await import('../dist/dashboard.js');
  const { applicationQuestions, supplementalAnswers }=await import('../dist/application-answers.js');
  const { saveResult }=await import('../dist/storage.js');
  for(const name of ['config','data','output'])await mkdir(name);
  const config={token:'PRIVATE-FIXTURE-TOKEN',dataSourceId:source,urlProperty:'URL',filter:{property:'Status',select:{equals:'New'}}};
  await writeFile('config/notion.json',JSON.stringify(config));await writeFile('config/profile.json',JSON.stringify({firstName:'Alex',lastName:'Example',email:'alex@fixture.test'}));await writeFile('config/answers.json','{}');await writeFile('data/jobs.txt','');
  const calls=[];
  const processor=async(job,advance,onInputs,autofill,applicationAnswers)=>{
    calls.push({url:job.url,applicationAnswers});
    const result={url:job.url,status:'ready_for_review',message:'Filled for review',timestamp:new Date().toISOString()};await saveResult(result);return result;
  };
  const state=new DashboardState(processor);await state.init();
  let view=await state.view();const urls=view.applications.map(job=>job.url);
  assert.deepEqual(urls,[3,2,4,1].map(n=>`https://jobs.fixture.test/${n}`),'Company then title then URL, across the entire snapshot');
  assert.deepEqual(view.notion.data.map(job=>job.url),urls);
  await state.select([urls[3],urls[0]],true);assert.equal(calls.length,0,'Selection never launches browser work');
  await state.select([urls[3]],false);assert.equal((await state.view()).worker.queued,1);
  assert.deepEqual((await state.view()).applications.map(job=>job.url),urls,'Queue membership cannot reorder rows');
  await state.select([urls[2],urls[3]],true);await state.start();await state.waitForIdle();
  assert.deepEqual(calls.map(call=>call.url),[urls[0],urls[2],urls[3]],'Workers claim the previewed alphabetical order');
  assert.deepEqual((await state.view()).applications.map(job=>job.url),urls,'Completion cannot reorder rows');
  const answeredUrl=urls[1],missing={url:answeredUrl,status:'needs_answers',message:'3 questions unresolved',timestamp:'2026-10-21T12:00:00.000Z',missing:[{label:'Why are you interested in this role?',type:'textarea'},{label:'Preferred start month',type:'select',options:['November','December']},{label:'Resume upload could not be confirmed',type:'file'}]};
  await saveResult(missing);await saveResult({url:urls[2],status:'error',message:'Fixture upload failed. Retry after choosing a valid resume.',timestamp:new Date().toISOString()});
  let questions=(await state.view()).applications.find(job=>job.url===answeredUrl).questions;
  assert.deepEqual(questions.map(q=>q.canAnswer),[true,true,false]);
  const answer=(index,value)=>({index,label:missing.missing[index].label,resultTimestamp:missing.timestamp,value});
  await assert.rejects(state.answer(answeredUrl,[answer(1,'January')]),/exact employer options/);
  await assert.rejects(state.answer(answeredUrl,[{...answer(0,'One employer only'),resultTimestamp:'old'}]),/questions changed/);
  await assert.rejects(state.answer(answeredUrl,[answer(2,'fake.pdf')]),/cannot be answered/);
  assert.equal(applicationQuestions({status:'needs_answers',missing:[{label:'Date',type:'text'},{label:'Date',type:'text'}]}, {}, {}).every(q=>!q.canAnswer),true);
  assert.equal(applicationQuestions({status:'needs_answers',missing:[{label:'What is your email address?',type:'text'}]}, {email:'approved@fixture.test'}, {}).at(0).canAnswer,false);
  assert.equal(supplementalAnswers({'What is your email address?':'approved@fixture.test'},{Email:'wrong@fixture.test'})['Email'],undefined,'Equivalent live approved answers take precedence');
  await state.answer(answeredUrl,[answer(0,'I enjoy building reliable systems.'),answer(1,'November')]);
  assert.equal(calls.length,3,'Saving answers only stages a retry');
  const restored=new DashboardState(processor);await restored.init();assert.equal((await restored.view()).worker.queued,1);
  assert.equal((await stat('output/dashboard-state.json')).mode & 0o777,0o600);
  await restored.start();await restored.waitForIdle();assert.equal(calls.at(-1).applicationAnswers['Preferred start month'],'November');
  assert.ok(calls.slice(0,3).every(call=>!call.applicationAnswers),'Answers are never shared with other applications');
  await restored.select([answeredUrl],true);await restored.updateTracking(answeredUrl,'status','Applied');
  assert.equal(pages[1].properties.Status.select.name,'Applied');
  view=await restored.view();let tracked=view.applications.find(job=>job.url===answeredUrl);
  assert.equal(tracked.tracking.status,'Applied');assert.equal(tracked.retryBlocked,true);assert.equal(view.worker.queued,0);
  assert.equal(view.notion.data.some(job=>job.url===answeredUrl),false,'Changed status leaves the eligible Notion selection');
  await restored.refresh();assert.equal((await restored.view()).applications.find(job=>job.url===answeredUrl).tracking.status,'Applied','Filtered-out rows retain confirmed tracking');
  await restored.addUrls(answeredUrl); // A manual alias must not override live Notion metadata.
  // GPT Web changes a filtered-out record: refresh still reconciles tracking.
  pages[1].properties.Status.select.name='Rejected';await restored.refresh();
  assert.equal((await restored.view()).applications.find(job=>job.url===answeredUrl).tracking.status,'Rejected');
  pages[1].properties.Status.select.name='Applied';await restored.refresh();
  // A remote writer wins over a stale local snapshot; no PATCH is attempted.
  const conflictBefore=patchCount;pages[2].properties.Status.select.name='Apply';
  await assert.rejects(restored.updateTracking(urls[0],'status','Applied'),/changed in Notion/);
  assert.equal(patchCount,conflictBefore);
  assert.equal((await restored.view()).applications.find(job=>job.url===urls[0]).tracking.status,'Apply');
  await assert.rejects(restored.updateTracking(urls[0],'status','Applied','New'),/changed since/);
  pages[2].properties.Status.select.name='New';await restored.refresh();
  const before=patchCount;await assert.rejects(restored.updateTracking(urls[0],'status','Invented'),/available/);assert.equal(patchCount,before);
  failPatch=true;await assert.rejects(restored.updateTracking(urls[0],'status','Closed'),/HTTP 403/);failPatch=false;
  assert.equal((await restored.view()).applications.find(job=>job.url===urls[0]).tracking.status,'New','Rejected saves never show as synced');
  ignorePatch=true;await assert.rejects(restored.updateTracking(urls[0],'status','Closed'),/did not confirm/);ignorePatch=false;
  await restored.updateTracking(urls[0],'lifecycle','Archived');assert.equal(pages[2].properties.Lifecycle.select.name,'Archived');assert.equal((await restored.view()).applications.find(job=>job.url===urls[0]).retryBlocked,true);
  await restored.select([urls[3]],true);await restored.remove(urls[3]);await restored.refresh();
  assert.equal((await restored.view()).applications.find(job=>job.url===urls[3]).removed,true,'Refresh cannot resurrect a removed job');
  assert.equal((await restored.view()).worker.queued,0);await restored.remove(urls[3],true);
  await restored.addUrls(answeredUrl);assert.equal((await restored.view()).worker.queued,0,'Pasting an Applied URL cannot requeue it');
  // Keep two unresolved rows in the UI fixture to exercise inline errors and actual answer entry.
  await restored.updateTracking(answeredUrl,'status','New');await saveResult(missing);await restored.refresh();
  server=createDashboardServer(restored);server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(7000);
  await page.goto(base);await page.locator('tr.application-row').first().waitFor();
  const row=url=>page.locator('tr.application-row').filter({has:page.locator('a.title[href="'+url+'"]')});
  const detail=url=>page.locator('tr.row-detail[data-for="'+url+'"]');
  assert.deepEqual(await page.locator('tr.application-row').evaluateAll(rows=>rows.map(row=>row.dataset.url)),urls);
  await row(urls[2]).getByRole('button',{name:'Details for',exact:false}).click();
  await row(answeredUrl).getByRole('button',{name:'Details for',exact:false}).click();
  assert.match(await detail(urls[2]).innerText(),/Fixture upload failed/);
  assert.equal(await row(urls[2]).innerText().then(text=>text.includes('Fixture upload failed')),false,'Error belongs below its application');
  await detail(answeredUrl).locator('summary').filter({hasText:'Additional information needed'}).click();
  await detail(answeredUrl).getByRole('textbox',{name:'Why are you interested in this role?',exact:true}).fill('My application-specific answer');
  // Refresh another source while this field has focus: polling must preserve drafts and caret.
  const token=(await(await originalFetch(base)).text()).match(/name="formwright-token" content="([^"]+)"/)[1];
  const post=(route,body)=>originalFetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Formwright-Token':token},body:JSON.stringify(body)});
  await post('refresh',{});await page.waitForTimeout(3300);
  assert.equal(await detail(answeredUrl).getByRole('textbox',{name:'Why are you interested in this role?',exact:true}).inputValue(),'My application-specific answer');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Why are you interested in this role?','Polling keeps keyboard focus');
  await detail(answeredUrl).getByRole('combobox',{name:'Preferred start month',exact:true}).selectOption('December');
  await detail(answeredUrl).getByRole('button',{name:'Save answers & queue retry'}).click();
  await row(answeredUrl).getByRole('status').filter({hasText:'Answers saved'}).waitFor();
  assert.equal((await restored.view()).worker.queued,1);assert.equal(calls.length,4,'UI save does not trigger autofill');
  await page.getByRole('button',{name:'Review queue',exact:false}).click();
  assert.equal(await page.locator('tr.application-row').count(),1);
  await row(answeredUrl).getByRole('checkbox').click();await page.getByText('Your queue is empty. Select jobs in All applications, then review them here before starting.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'All applications',exact:true}).click();
  const tracking=row(urls[3]).getByRole('combobox',{name:'Application status for Backend Engineer',exact:true});
  failPatch=true;await tracking.selectOption('Closed');await row(urls[3]).getByRole('alert').filter({hasText:'HTTP 403'}).waitFor();failPatch=false;
  assert.equal(await tracking.inputValue(),'New','Failed status save restores confirmed value');
  await tracking.selectOption('Closed');await row(urls[3]).getByRole('status').filter({hasText:'Saved and verified in Notion'}).waitFor();
  assert.equal(await tracking.inputValue(),'Closed');
  await row(urls[3]).getByRole('button',{name:'Details for',exact:false}).click();const manage=detail(urls[3]);
  await manage.getByText('Remove this application…',{exact:true}).click();await manage.getByRole('button',{name:'Remove from dashboard'}).click();
  await page.waitForFunction(url=>![...document.querySelectorAll('tr.application-row')].some(row=>row.dataset.url===url),urls[3]);
  await page.getByRole('button',{name:'Removed',exact:true}).click();await page.getByRole('button',{name:'Restore',exact:true}).click();
  await page.getByRole('button',{name:'All applications',exact:true}).click();
  if(await row(answeredUrl).getByRole('button',{name:'Details for',exact:false}).count()) await row(answeredUrl).getByRole('button',{name:'Details for',exact:false}).click();
  await page.screenshot({path:path.join(cwd,'output/playwright/workspace-desktop.png'),fullPage:true});
  for(const width of [390,768]){
    await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No page overflow at '+width);
    await page.screenshot({path:path.join(cwd,'output/playwright/workspace-'+width+'.png'),fullPage:true});
  }
  assert.deepEqual(errors,[],'No dashboard runtime errors');
  const denied=await originalFetch(base+'/api/selection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({urls:[answeredUrl],selected:true})});assert.equal(denied.status,403);
  for(const route of ['tracking','remove','restore','answers'])assert.equal((await post(route,{})).status,400,'Validate '+route+' input');
  console.log('PASS: alphabetical stable rows/queue, selection and preview, scoped answers/retry, persistence/removal, real Notion option validation/PATCH/readback failures, inline UI errors/forms, draft/focus retention and responsive layouts.');
} finally {
  globalThis.fetch=originalFetch;if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}process.chdir(cwd);await rm(dir,{recursive:true,force:true});
}
