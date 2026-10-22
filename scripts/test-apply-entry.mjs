import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { accountHandoffHandler } from '../dist/account-auth.js';
import { openApplication, ApplicationHandoff } from '../dist/application-entry.js';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType:'text/html', body:`
    <main><h1>Backend Engineer</h1>
    <label>Job alert email<input name="emailAddress" type="email"></label>
    <a role="button" href="#" data-automation-id="adventureButton">Apply</a>
    </main>` }));
  await page.goto('https://example.myworkdayjobs.com/en-US/jobs/job/engineer');
  await page.locator('[data-automation-id="adventureButton"]').evaluate(el=>el.addEventListener('click',event=>{
    event.preventDefault();window.entryClicked=true;
    document.querySelector('main').innerHTML='<h1>Sign in</h1><input type="email"><input type="password">';
  }));
  let logins=0;
  await openApplication(page, 'Workday', async active => {
    assert.equal(await active.evaluate(()=>window.entryClicked || false),true,'Apply must open login before account handling');
    logins++;
    await active.setContent('<main><h2>Apply for this job</h2><label>First name<input name="first_name"></label><label>Last name<input name="last_name"></label><label>Email<input type="email" name="email"></label><button data-automation-id="bottom-navigation-next-button">Submit</button></main>');
  });
  assert.equal(await page.evaluate(()=>window.entryClicked || false),true,'Must click Apply rather than mistake a listing contact field for the application');
  assert.equal(logins,1,'Login should be reached after clicking Apply');
  console.log('PASS: listing email widget does not skip Apply before login.');
  const fields='<label>First name<input name="first_name" id="first_name"></label><label>Last name<input name="last_name" id="last_name"></label><label>Email<input type="email" name="email" id="email"></label>';
  const application=`<form id="application-form"><h2>Apply for this job</h2>${fields}<button type="button" id="btn-submit" onclick="window.submitted=true">Submit application</button></form>`;
  const destination='https://jobs.lever.co/entry/engineer/apply';
  // Duplicate header/footer links with the same target are one routing choice.
  const duplicates=await browser.newPage();let popups=0;duplicates.on('popup',()=>popups++);
  await duplicates.context().route('**/*',route=>route.fulfill({contentType:'text/html',body:route.request().url()===destination ? application : `<h1>Backend Engineer</h1><a href="${destination}" target="_blank">Apply</a><footer><a href="${destination}" target="_blank">Apply now</a></footer>`}));
  await duplicates.goto('https://employer.fixture.test/engineer');
  const duplicateEntry=await openApplication(duplicates,null);
  assert.equal(duplicateEntry.page.url(),destination);assert.equal(popups,1);
  assert.equal(await duplicateEntry.page.evaluate(()=>window.submitted || false),false);
  console.log('PASS: repeated header/footer Apply links open one application tab.');
  // Entry controls can be in an embedded employer portal, before an ATS is known.
  const embedded=await browser.newPage();
  await embedded.context().route('**/*',route=>route.fulfill({contentType:'text/html',body:route.request().url()===destination ? application : route.request().url().includes('portal.fixture.test') ? `<h1>Backend Engineer</h1><a href="${destination}" target="_blank">Apply to this position</a>` : '<h1>Careers</h1><iframe title="Job details" src="https://portal.fixture.test/engineer"></iframe>'}));
  await embedded.goto('https://employer.fixture.test/embedded');
  const embeddedEntry=await openApplication(embedded,null);
  assert.equal(embeddedEntry.page.url(),destination);assert.equal(embeddedEntry.ats,'Lever');
  assert.notEqual(embeddedEntry.page,embedded);
  console.log('PASS: embedded Apply control reaches the actual application in a popup.');
  // A visible but empty application wrapper is not an opened application.
  const shell=await browser.newPage();
  await shell.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<button class="jobs-apply-button" type="button">Easy Apply</button><div class="jobs-easy-apply-modal" role="dialog"></div>'}));
  await shell.goto('https://www.linkedin.com/jobs/view/entry-shell');
  await shell.locator('button').evaluate((button,html)=>button.addEventListener('click',()=>{window.entryClicked=true;document.querySelector('[role=dialog]').innerHTML=html;button.remove();}),application);
  await openApplication(shell,'LinkedIn');
  assert.equal(await shell.evaluate(()=>window.entryClicked || false),true);
  console.log('PASS: empty application wrapper does not skip the initial Apply action.');
  // A final native submit labelled Apply must never be clicked during entry.
  const finalApply=await browser.newPage();
  await finalApply.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<form id="application-form" onsubmit="event.preventDefault();window.submitted=true"><h2>Application</h2><label>Email<input type="email" name="email"></label><button type="submit">Apply</button></form>`}));
  await finalApply.goto('https://boards.greenhouse.io/fixture/jobs/final-apply');
  await openApplication(finalApply,'Greenhouse');
  assert.equal(await finalApply.evaluate(()=>window.submitted || false),false);
  console.log('PASS: final Apply submit is left untouched.');
  // A persistent Apply link must not restart a form that is already open.
  const ready=await browser.newPage();
  await ready.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<a href="/restart" onclick="window.restarted=true">Apply</a>${application}`}));
  await ready.goto('https://jobs.lever.co/entry/ready/apply');await openApplication(ready,'Lever');
  assert.equal(await ready.evaluate(()=>window.restarted || false),false);
  console.log('PASS: ready application does not restart through a persistent header link.');
  const ambiguous=await browser.newPage();
  await ambiguous.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<h1>Backend Engineer</h1><a href="/one">Apply</a><a href="/two">Apply</a>'}));
  await ambiguous.goto('https://employer.fixture.test/ambiguous');
  await assert.rejects(openApplication(ambiguous,null),err=>err instanceof ApplicationHandoff && err.reason==='navigation' && /Multiple/.test(err.message));
  assert.equal(ambiguous.url(),'https://employer.fixture.test/ambiguous');
  console.log('PASS: different Apply destinations still require review.');
  // Run the complete Apply -> shared credentials -> actual application chain.
  const loginPage=await browser.newPage();const password='offline-entry-secret';
  await loginPage.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<h1>Backend Engineer</h1><label>Job alert email<input name="emailAddress" type="email"></label><button type="button" id="entry">Apply</button>'}));
  await loginPage.goto('https://example.myworkdayjobs.com/en-US/jobs/job/auth-entry');
  await loginPage.locator('#entry').evaluate((button,html)=>button.addEventListener('click',()=>{
    window.entryClicked=true;
    document.body.innerHTML='<h1>Sign in</h1><form><input type="email" required><input type="password" required><button type="button">Sign in</button></form>';
    document.querySelector('button').addEventListener('click',()=>{
      window.accountValues=[...document.querySelectorAll('input')].map(input=>input.value);
      document.body.innerHTML=html;
    });
  }),application);
  const auth=accountHandoffHandler({enabled:true,allowSignup:false,username:'account@fixture.test',password,allowedHosts:['example.myworkdayjobs.com']},{firstName:'Alex',lastName:'Example',fullName:'Alex Example'});
  await openApplication(loginPage,'Workday',auth);
  assert.equal(await loginPage.evaluate(()=>window.entryClicked || false),true);
  assert.deepEqual(await loginPage.evaluate(()=>window.accountValues),['account@fixture.test',password]);
  assert.equal(await loginPage.locator('#first_name').isVisible(),true);
  assert.equal(await loginPage.evaluate(()=>window.submitted || false),false);
  console.log('PASS: Apply opens login, shared credentials complete it, and routing reaches the application without submission.');

} finally { await browser.close(); }
