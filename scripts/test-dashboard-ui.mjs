import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';

const assetDir=process.env.FORMWRIGHT_UI_ASSETS || new URL('../web/',import.meta.url).pathname;
const legacy=!!process.env.FORMWRIGHT_UI_ASSETS;
const statuses=['not_started','ready_for_review','needs_answers','error','submitted'];
const companies=['Aster Labs','Brightside','Cedar Systems','Daybreak','Evergreen','Fieldwork','Good Signal','Harbor','Juniper','Kindred','Lumen','Northstar'];
const applications=Array.from({length:1000},(_,i)=>({url:`https://jobs.example.com/role-${i}`,sources:['Notion'],notion:{title:['Platform Engineer','Backend Engineer','Software Engineer'][i%3],company:`${companies[i%12]} ${String(i).padStart(4,'0')}`,pageUrl:`https://notion.so/fixture-${i}`},tracking:{status:i%5===4?'Applied':'New',lifecycle:'Active',statusOptions:['New','Apply','Applied','Rejected','Closed'],lifecycleOptions:['Active','Archived']},result:i%5?{status:statuses[i%5],timestamp:'2026-10-22T14:00:00Z',message:i%5===2?'Additional employer information is needed.':'Synthetic review fixture.'}:undefined,retryBlocked:i%5===4,questions:[]}));
const snapshot={applications,worker:{active:[],running:false,paused:true,queued:0,concurrency:3,advance:true,autofill:{mode:'deterministic',baseUrl:'http://127.0.0.1:1234/v1',model:''}},notion:{data:applications.slice(0,20),fetchedAt:'2026-10-22T14:00:00Z'},file:{data:[]},answers:{data:{entries:[]}},config:{data:{profile:{firstName:'Alex'},notion:{},account:{allowedHosts:[]}}}};
const errors=[],requests=[];let failNext=false,requestDelay=0;
const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/state'){res.end(JSON.stringify(snapshot));return;}
  if(req.method==='POST'){
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push({route:req.url,body});
    if(requestDelay)await new Promise(resolve=>setTimeout(resolve,requestDelay));
    if(failNext){failNext=false;res.statusCode=400;res.end(JSON.stringify({error:'Fixture conflict: refresh and choose again.'}));return;}
    if(req.url==='/api/tracking')snapshot.applications.find(job=>job.url===body.url).tracking[body.field]=body.value;
    if(req.url==='/api/selection')for(const url of body.urls){const job=snapshot.applications.find(job=>job.url===url);job.task=body.selected?{state:'queued'}:undefined;}
    res.end(JSON.stringify({message:'Saved and verified in Notion.'}));return;
  }
  const file=req.url==='/'?'dashboard.html':req.url.slice(1);
  if(!['dashboard.html','dashboard.css','dashboard.js','theme.js'].includes(file)){res.statusCode=404;res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
  res.end(await readFile(assetDir+'/'+file,'utf8'));
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'light'});page.on('pageerror',e=>errors.push(e.message));
  const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  const start=performance.now();await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('tr.application-row').first().waitFor();
  const bootMs=Math.round(performance.now()-start);
  const timings=[];
  for(const query of ['Aster','Engineer','Harbor','','Platform']){
    timings.push(await page.evaluate(async query=>{const start=performance.now(),input=document.querySelector('#search');input.value=query;input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return performance.now()-start;},query));
  }
  await page.locator('#search').fill('');
  const count=await page.locator('tr.application-row').count();
  if(!legacy){
    assert.equal(await page.locator('h1:visible').count(),1);
    assert.equal(await page.getByRole('button',{name:'Add to queue',exact:true}).count(),0,'Selection uses the checkbox, with no duplicate row action');
    await page.locator('tr.application-row').first().getByRole('button',{name:'Details for',exact:false}).click();
    assert.match(await page.locator('.row-detail').innerText(),/jobs.example.com.*Notion/,'Source metadata remains available in Details');
    await page.locator('tr.application-row').first().getByRole('button',{name:'Close details for',exact:false}).click();
  }
  if(!legacy){
    assert.equal(count,50);assert.ok(Math.max(...timings)<500,`Search exceeded 500ms lab budget: ${timings}`);
    await page.locator('#page-next').click();assert.match(await page.locator('#page-summary').innerText(),/51–100/);await page.locator('#page-prev').click();
    await page.locator('#theme').selectOption('dark');await page.reload();assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
    assert.equal(await page.locator('html').evaluate(el=>getComputedStyle(el).colorScheme),'dark');
    await page.locator('#theme').selectOption('system');await page.emulateMedia({colorScheme:'dark'});assert.equal(await page.locator('html').evaluate(el=>getComputedStyle(el).colorScheme),'dark');
    await page.emulateMedia({colorScheme:'light'});assert.equal(await page.locator('html').evaluate(el=>getComputedStyle(el).colorScheme),'light');
    // A slow save must not lock unrelated rows, search or theme controls.
    requestDelay=400;
    const rows=page.locator('tr.application-row');
    await rows.nth(0).getByRole('combobox').selectOption('Apply');
    assert.equal(await rows.nth(1).getByRole('combobox').isEnabled(),true);
    await rows.nth(1).getByRole('button',{name:'Mark applied',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.row-feedback').length===2 && [...document.querySelectorAll('.row-feedback')].every(n=>n.textContent.includes('Saved and verified')));
    assert.equal(snapshot.applications[0].tracking.status,'Apply');assert.equal(snapshot.applications[1].tracking.status,'Applied');
    assert.equal(requests.filter(r=>r.route==='/api/tracking').length,2);
    assert.equal(requests[0].body.expected,'New');
    failNext=true;await rows.nth(0).getByRole('combobox').selectOption('Closed');await rows.nth(0).getByRole('alert').waitFor();assert.equal(await rows.nth(0).getByRole('combobox').inputValue(),'Apply');
    requestDelay=0;
    // All visible selection is bounded to the page, not the entire 1,000-row result set.
    await page.locator('#select-visible').click();await page.waitForFunction(()=>!document.querySelector('#select-visible').disabled);
    assert.ok(requests.findLast(r=>r.route==='/api/selection').body.urls.length<=50);
    assert.equal(await page.locator('#select-visible').isChecked(),true,'Selection is read back from saved state');
    await page.getByRole('button',{name:'Notion pipeline',exact:false}).click();assert.equal(await page.locator('#notion').isVisible(),true);
    await page.keyboard.press('/');assert.equal(await page.locator('#search').evaluate(n=>n===document.activeElement),true);
    await page.locator('#search').blur();await page.keyboard.press('n');assert.equal(await page.locator('#urls').evaluate(n=>n===document.activeElement),true);
    await page.locator('#urls').fill('https://jobs.example.com/new');assert.equal(await page.locator('#urls').inputValue(),'https://jobs.example.com/new');
    await page.locator('#add-box').evaluate(n=>n.hidden=true);
    await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('#start').evaluate(n=>getComputedStyle(n).transitionDuration),'0s');
    // Freeze worker rows for stable visual comparison. Screenshots contain synthetic data only.
    snapshot.applications=snapshot.applications.slice(0,12);snapshot.applications.forEach(job=>delete job.task);
    await page.reload();await page.locator('tr.application-row').first().waitFor();
    await mkdir('output/playwright',{recursive:true});
    for(const theme of ['light','dark']){
      await page.locator('#theme').selectOption(theme);
      // Check body/muted/semantic token contrast in each actual browser theme.
      const contrast=await page.evaluate(()=>{
        const probe=document.createElement('span');document.body.append(probe);
        const rgb=v=>{probe.style.color=`var(${v})`;return getComputedStyle(probe).color.match(/[\d.]+/g).slice(0,3).map(Number);};
        const lum=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
        const pairs=[['--ink','--surface'],['--muted','--surface'],['--muted','--subtle'],['--accent','--accent-soft'],['--accent-ink','--accent'],['--red','--error-soft'],['--warning','--warning-soft']];
        const result=pairs.map(([a,b])=>{const x=lum(rgb(a)),y=lum(rgb(b));return {pair:a+'/'+b,ratio:(Math.max(x,y)+.05)/(Math.min(x,y)+.05)};});probe.remove();return result;
      });
      assert.ok(contrast.every(pair=>pair.ratio>=4.5),JSON.stringify({theme,contrast}));
      for(const width of [1440,768,390]){
        await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${theme} overflow at ${width}`);
        await page.screenshot({path:`output/playwright/overhaul-${theme}-${width}.png`,fullPage:true});
      }
    }
    // Reading the guide must preserve the queue and must never trigger a command.
    const commandsBeforeGuide=requests.length;
    await page.getByRole('button',{name:'How to use',exact:true}).click();
    assert.equal(await page.locator('#help').isVisible(),true);
    assert.equal(await page.locator('#view-name').innerText(),'How to use');
    assert.equal(await page.locator('#applications').isVisible(),false);
    assert.equal(await page.locator('#help .guide-steps>li').count(),6);
    await page.getByRole('button',{name:'How to use',exact:true}).focus();
    await page.keyboard.press('Enter');
    for(const theme of ['light','dark']){
      await page.locator('#theme').selectOption(theme);
      for(const width of [1440,768,390]){
        await page.setViewportSize({width,height:1000});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Guide overflow at ${theme} ${width}`);
        await page.getByText('No jobs appear',{exact:true}).click();
        assert.equal(await page.locator('#help details').first().getAttribute('open'),'');
        await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);});
        await page.screenshot({path:`output/playwright/guide-${theme}-${width}.png`,fullPage:true});
        await page.getByText('No jobs appear',{exact:true}).click();
      }
    }
    assert.equal(requests.length,commandsBeforeGuide,'Guide navigation and disclosures are read-only');
    await page.getByRole('button',{name:/^Applications/}).click();
    assert.equal(await page.locator('#applications').isVisible(),true);
    assert.equal(await page.locator('#help').isVisible(),false);
    assert.equal(await page.locator('button:not([aria-label])').evaluateAll(nodes=>nodes.every(n=>n.textContent.trim())),true,'Buttons have text or labels');
  }
  const metrics={fixtureJobs:1000,cpuThrottle:4,renderedRows:count,bootMs,searchPaintMs:timings.map(Math.round),maxSearchPaintMs:Math.round(Math.max(...timings)),jsBytes:(await readFile(assetDir+'/dashboard.js')).length,cssBytes:(await readFile(assetDir+'/dashboard.css')).length};
  await mkdir('output',{recursive:true});await writeFile(`output/ui-performance-${legacy?'before':'after'}.json`,JSON.stringify(metrics,null,2));
  assert.deepEqual(errors,[]);console.log('PASS: dashboard UI '+JSON.stringify(metrics));
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
