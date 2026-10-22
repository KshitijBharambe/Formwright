import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {detectHandoff,openApplication} from '../dist/application-entry.js';
import {accountHandoffHandler} from '../dist/account-auth.js';
import {findApplicationScope} from '../dist/form-detection.js';
import {fillJourney} from '../dist/journey.js';
const browser=await chromium.launch({headless:true});
const profile={firstName:'Alex',lastName:'Example',fullName:'Alex Example',email:'alex@fixture.test',phone:'5555550100',resumePath:import.meta.filename};
const credentials={enabled:true,allowSignup:false,username:'account@fixture.test',password:'offline-yc-secret',allowedHosts:['*.ycombinator.com']};
const form='<div role="dialog" aria-modal="true"><h3>Apply to Within</h3><form action="#"><input id="first_name" name="first_name" placeholder="First Name *"><input id="last_name" name="last_name" placeholder="Last Name *"><input type="email" name="email" placeholder="Email Address *"><textarea placeholder="What interests you about Within?"></textarea><button type="submit" onclick="event.preventDefault();window.submitted=true">Submit</button></form></div>';
try {
  if(process.argv.includes('--login')) {
    const context=await browser.newContext();
    const jobAfterLogin='https://www.ycombinator.com/companies/within/jobs/LcmNldo-ai-backend-engineer';
    const used={};await context.exposeFunction('recordAccount',(key,value)=>{used[key]=value;});
    await context.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:route.request().url()===jobAfterLogin ? form : '<form id="sign-in-card" novalidate><h1>Log in or sign up to access Work at a Startup</h1><label for="ycid-input">Email or username</label><input id="ycid-input" autocomplete="username" inputmode="text" type="text" name="username"><button type="button">Continue</button></form>'}));
    const page=await context.newPage();await page.goto('https://account.ycombinator.com/');
    const detected=await detectHandoff(page);assert.equal(detected?.reason,'login','YC text username field must be detected as login');
    await page.locator('button').evaluate((button,html)=>button.addEventListener('click',()=>{
      window.recordAccount('username',document.querySelector('input').value);
      document.querySelector('form').innerHTML='<h1>Log in</h1><input type="password" autocomplete="current-password"><button type="button">Log in</button>';
      document.querySelector('button').addEventListener('click',()=>{window.recordAccount('password',document.querySelector('input').value).then(()=>{location.href=html;});});
    }),jobAfterLogin);
    const entry=await openApplication(page,null,accountHandoffHandler(credentials,profile));
    assert.deepEqual(used,{username:credentials.username,password:credentials.password});
    assert.ok(await findApplicationScope(entry.page,1000,entry.ats));assert.equal(await page.evaluate(()=>window.submitted||false),false);
    console.log('PASS: YC text username -> password -> application uses shared credentials without submission.');
  } else {
    const context=await browser.newContext();
    let rejectWrong;const wrongNavigation=new Promise((_,reject)=>{rejectWrong=reject;});
    const job='https://www.ycombinator.com/companies/within/jobs/LcmNldo-ai-backend-engineer';
    await context.route('**/*',route=>{
      if(route.request().url()!==job){rejectWrong(Error('Runner followed the global founder Apply link instead of Apply to role'));return route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>Apply to YC</h1>'});}
      return route.fulfill({contentType:'text/html; charset=utf-8',body:'<nav><a href="/apply">Apply</a></nav><main><h1>AI Backend Engineer</h1><a id="role" href="https://account.ycombinator.com/authenticate">Apply to role ›</a></main><input id="background-email" type="email"><div id="portal"></div>'});
    });
    const page=await context.newPage();await page.goto(job);
    await page.locator('#role').evaluate((link,html)=>link.addEventListener('click',event=>{event.preventDefault();window.roleClicked=true;document.querySelector('#portal').innerHTML=html;}),form);
    const entry=await Promise.race([openApplication(page,null),wrongNavigation]);
    assert.equal(await page.evaluate(()=>window.roleClicked||false),true);assert.equal(page.url(),job);assert.equal(entry.ats,'YCombinator');
    const scope=await findApplicationScope(page,1000,entry.ats);assert.ok(scope);
    await fillJourney(page,scope,profile,{},entry.ats,false,1);
    assert.equal(await page.locator('[role=dialog] #first_name').inputValue(),profile.firstName);
    assert.equal(await page.locator('[role=dialog] [name=email]').inputValue(),profile.email);
    assert.equal(await page.locator('#background-email').inputValue(),'');
    assert.equal(await page.evaluate(()=>window.submitted||false),false);
    console.log('PASS: role CTA overrides YC founder Apply; placeholder-only modal is scoped and autofilled without touching background fields or Submit.');
    await page.locator('[role=dialog] form').evaluate(el=>el.insertAdjacentHTML('afterbegin','<iframe title="hCaptcha checkbox" width="300" height="75" srcdoc="<label><input type=checkbox>I am human</label>"></iframe>'));
    await page.locator('[name=first_name]').fill('');
    const challenged=await openApplication(page,null);
    const challengeScope=await findApplicationScope(page,1000,challenged.ats);
    await fillJourney(page,challengeScope,profile,{},challenged.ats,false,1);
    assert.equal(await page.locator('[name=first_name]').inputValue(),profile.firstName);
    const captcha=page.frames().find(frame=>frame!==page.mainFrame());
    assert.equal(await captcha.locator('input[type=checkbox]').isChecked(),false);
    assert.equal(await page.evaluate(()=>window.submitted||false),false);
    console.log('PASS: approved fields fill before CAPTCHA handoff; verification and Submit stay untouched.');
    await page.reload();await page.locator('#role').evaluate(el=>el.remove());
    await assert.rejects(openApplication(page,null),/role-specific Apply/i,'Missing job CTA must never fall back to the founder application');
    console.log('PASS: missing YC role CTA fails closed instead of following global Apply.');
  }
}finally{await browser.close();}
