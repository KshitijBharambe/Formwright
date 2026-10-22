import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const original=process.cwd();
const dir=await mkdtemp(path.join(tmpdir(),'formwright-auth-config-'));
process.chdir(dir);
let browser;
try {
  await mkdir('config');
  await writeFile('config/profile.json',JSON.stringify({firstName:'Alex',lastName:'Example',fullName:'Alex Example',email:'alex@fixture.test',phone:'5555550100',resumePath:import.meta.filename}));
  const {runJobs}=await import('../dist/run.js');
  const {saveAuthSettings}=await import('../dist/auth-settings.js');
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext();
  let clicks=0;
  await context.exposeFunction('loginClick',()=>{clicks++;});
  await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<h1>Sign in</h1><form><input type="email" required><input type="password" required><button type="button" onclick="loginClick()">Sign in</button></form>'}));
  const results=[];
  await runJobs(new Set(),{context,jobs:[{url:'https://accounts.fixture.test/missing'}],onResult:value=>results.push(value)});
  assert.equal(results[0].status,'needs_answers');
  assert.match(results[0].message,/No shared login credentials.*Configuration/s,'Missing credentials must be explained instead of a generic login handoff');
  assert.equal(clicks,0);
  await saveAuthSettings({enabled:false,username:'account@fixture.test',password:'OFFLINE-PASSWORD',allowedHosts:['accounts.fixture.test']});
  await runJobs(new Set(),{context,jobs:[{url:'https://accounts.fixture.test/disabled'}],onResult:value=>results.push(value)});
  assert.match(results[1].message,/Automatic sign-in is disabled.*Configuration/s);
  assert.equal(JSON.stringify(results).includes('OFFLINE-PASSWORD'),false);
  assert.equal(clicks,0);
  console.log('PASS: runner explains missing credentials and disabled auto-login without filling, clicking or logging secrets.');
} finally {await browser?.close();process.chdir(original);await rm(dir,{recursive:true,force:true});}
