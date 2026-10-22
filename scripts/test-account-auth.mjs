import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { accountHandoffHandler } from '../dist/account-auth.js';
import { requireApplicationAccess, ApplicationHandoff } from '../dist/application-entry.js';
import { credentialsAllowed, validateAuthSettings } from '../dist/auth-settings.js';

const credentials = { enabled: true, allowSignup: true, username: 'account@fixture.test', password: 'fixture-only-secret!', allowedHosts: ['accounts.fixture.test'] };
const profile = { firstName: 'Alex', lastName: 'Example', fullName: 'Alex Example' };
const login = '<h1>Sign in</h1><form><label>Email<input type="email" required></label><label>Password<input type="password" required></label><button type="button">Sign in</button></form>';
const signup = '<h1>Create account</h1><form><label>First name<input name="firstName" required></label><label>Email<input type="email" required></label><label>Password<input type="password" required></label><label>Confirm password<input type="password" required></label><button type="button">Create account</button></form>';
assert.equal(credentialsAllowed('https://accounts.fixture.test/login', credentials), true);
for (const url of ['http://accounts.fixture.test', 'https://accounts.fixture.test.evil.test', 'https://other.fixture.test']) assert.equal(credentialsAllowed(url, credentials), false);
assert.equal(credentialsAllowed('https://tenant.myworkdayjobs.com', { ...credentials, allowedHosts: ['*.myworkdayjobs.com'] }), true);
assert.equal(credentialsAllowed('https://myworkdayjobs.com', { ...credentials, allowedHosts: ['*.myworkdayjobs.com'] }), false);
assert.throws(() => validateAuthSettings({ ...credentials, allowedHosts: ['*'] }));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
let markup = login;
await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: markup }));
const handler = accountHandoffHandler(credentials, profile);
const page = await context.newPage();
page.setDefaultTimeout(1500);
async function load(html = login, url = 'https://accounts.fixture.test/login') { markup = html; await page.goto(url); }
async function succeeds() {
  await page.getByRole('button').evaluate(button => button.addEventListener('click', () => {
    window.accountValues = [...document.querySelectorAll('input')].map(input => input.value);
    window.authClicks = (window.authClicks || 0) + 1;
    document.body.innerHTML = '<h1>Apply for this job</h1><button>Submit application</button>';
  }));
}
const handoff = (reason) => error => error instanceof ApplicationHandoff && error.reason === reason && !error.message.includes(credentials.password);
try {
  await load(); await succeeds();
  assert.equal(await requireApplicationAccess(page, handler), true);
  assert.deepEqual(await page.evaluate(() => window.accountValues), [credentials.username, credentials.password]);
  assert.equal(await page.evaluate(() => window.authClicks), 1);
  await load(signup); await succeeds();
  await requireApplicationAccess(page, handler);
  assert.deepEqual(await page.evaluate(() => window.accountValues), [profile.firstName, credentials.username, credentials.password, credentials.password]);
  await load(signup);
  await assert.rejects(requireApplicationAccess(page, accountHandoffHandler({ ...credentials, allowSignup: false }, profile)), handoff('login'));
  assert.equal(await page.locator('input[type=password]').first().inputValue(), '');
  await load(login.replace('</form>', '<label><input type="checkbox" required>Accept terms</label></form>'));
  await assert.rejects(requireApplicationAccess(page, handler), handoff('login'));
  assert.equal(await page.locator('input[type=password]').inputValue(), '');
  assert.equal(await page.locator('input[type=checkbox]').isChecked(), false);
  await load(login, 'https://accounts.fixture.test.evil.test/login');
  await assert.rejects(requireApplicationAccess(page, handler), handoff('login'));
  assert.equal(await page.locator('input[type=password]').inputValue(), '');
  await context.route('https://unlisted.fixture.test/login', route => route.fulfill({contentType:'text/html',body:login}));
  await load('<iframe title="Account" src="https://unlisted.fixture.test/login"></iframe>');
  const accountFrame=page.frame({url:'https://unlisted.fixture.test/login'});
  await accountFrame.locator('input[type=password]').waitFor();
  await assert.rejects(requireApplicationAccess(page, handler), handoff('login'));
  assert.equal(await accountFrame.locator('input[type=password]').inputValue(),'');
  await load(login.replace('<form>', '<form action="https://other.fixture.test/login">'));
  await assert.rejects(requireApplicationAccess(page, handler), handoff('login'));
  assert.equal(await page.locator('input[type=password]').inputValue(), '');
  await load();
  await page.getByRole('button').evaluate(button => button.addEventListener('click', () => {
    window.authClicks = (window.authClicks || 0) + 1;
    document.body.insertAdjacentHTML('beforeend', '<p role="alert">Incorrect password</p><a href="/signup">Create account</a>');
  }));
  await assert.rejects(requireApplicationAccess(page, handler), handoff('login'));
  assert.equal(await page.evaluate(() => window.authClicks), 1, 'No retry and no signup after rejected login');
  const rejectedSibling=await context.newPage();markup=login;await rejectedSibling.goto('https://accounts.fixture.test/login');
  await assert.rejects(requireApplicationAccess(rejectedSibling,handler),handoff('login'));
  assert.equal(await rejectedSibling.locator('input[type=password]').inputValue(),'');await rejectedSibling.close();
  const verifyHandler = accountHandoffHandler({...credentials, username:'verify@fixture.test'}, profile);
  await load();
  await page.getByRole('button').evaluate(button => button.addEventListener('click', () => {
    document.body.innerHTML = '<h1>Check your email</h1><input autocomplete="one-time-code">';
  }));
  await assert.rejects(requireApplicationAccess(page, verifyHandler), handoff('verification'));
  assert.equal(await page.locator('input').inputValue(), '');
  await load('<h1>Sign in</h1><form><label>Email<input type="email"></label><button type="button">Continue</button></form>');
  await page.getByRole('button').evaluate(button => button.addEventListener('click', () => {
    document.body.innerHTML = '<h1>Sign in</h1><form><input type="password"><button type="button" onclick="document.body.innerHTML=\'<h1>Apply for this job</h1>\'">Sign in</button></form>';
  }));
  await requireApplicationAccess(page, accountHandoffHandler({...credentials, username:'email-first@fixture.test'}, profile));
  assert.equal(await page.locator('h1').innerText(), 'Apply for this job');
  // Same-origin authentication is serialized; the second tab reuses the cookie.
  const shared = await browser.newContext();
  let attempts = 0;
  await shared.route('**/*', route => {
    const authenticated = (route.request().headers().cookie || '').includes('session=yes');
    return route.fulfill({ contentType: 'text/html', body: authenticated ? '<h1>Apply for this job</h1>' : login + '<script>document.querySelector("button").onclick=()=>{document.cookie="session=yes;path=/";document.body.innerHTML="<h1>Apply for this job</h1>";}</script>' });
  });
  const tabs = await Promise.all([shared.newPage(), shared.newPage()]);
  for (const tab of tabs) { await tab.goto('https://accounts.fixture.test/login'); await tab.exposeFunction('attempt', () => { attempts++; }); await tab.getByRole('button').evaluate(button => button.addEventListener('click', () => window.attempt())); }
  await Promise.all(tabs.map(tab => requireApplicationAccess(tab, handler)));
  assert.equal(attempts, 1, 'Only one login for concurrent same-origin tabs');
  await shared.close();
  await load();
  await assert.rejects(requireApplicationAccess(page, accountHandoffHandler({ ...credentials, enabled: false }, profile)), error => error instanceof ApplicationHandoff && /Automatic sign-in is disabled.*Configuration/s.test(error.message));
  assert.equal(await page.locator('input[type=password]').inputValue(), '');
  let manualReason;
  await requireApplicationAccess(page, accountHandoffHandler({ ...credentials, enabled: false }, profile, async (active, reason) => {
    manualReason=reason.message;await active.setContent('<h1>Apply for this job</h1>');
  }));
  assert.match(manualReason,/disabled.*Configuration/s);
  console.log('PASS: shared login/signup, email-first login, consent, rejected credentials, allowed hosts, verification and concurrent session reuse.');
} finally { await browser.close(); }
