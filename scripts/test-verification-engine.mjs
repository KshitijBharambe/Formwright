import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fillApplication } from '../dist/form.js';

const profile = { firstName: 'Alex', lastName: 'Example', fullName: 'Alex Example',
  email: 'alex@fixture.test', phone: '5555550100', resumePath: import.meta.filename };
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(1000);
  let requests = 0;
  await page.route('**/*', route => { requests++; return route.abort(); });
  await page.setContent(`<form><label for="email">Email</label><input id="email" type="email" required>
    <div id="followup"></div><button type="button" onclick="window.submitted=true">Submit</button>
    <script>email.addEventListener('blur', () => setTimeout(() => {
      document.querySelector('#followup').innerHTML = '<label for="last">Last name</label><input id="last" required>';
    }, 250), {once:true});</script></form>`);
  let result = await fillApplication(page, profile, {});
  assert.equal(await page.locator('#last').inputValue(), profile.lastName, 'Discover delayed conditional controls before readiness');
  assert.deepEqual(result.missing, []);

  await page.setContent(`<form><label for="email">Email</label><input id="email" type="email" required>
    <div id="followup"></div><script>email.addEventListener('blur', () => setTimeout(() => {
      document.querySelector('#followup').innerHTML = '<label for="legal">Unapproved legal question</label><input id="legal" required>';
    }, 250), {once:true});</script></form>`);
  result = await fillApplication(page, profile, {});
  assert.ok(result.missing.some(field => field.id === 'legal'), 'Delayed consequential questions must block readiness');
  assert.equal(await page.locator('#legal').inputValue(), '');

  await page.setContent(`<form><label for="email">Email</label><input id="email" type="email" required>
    <script>email.addEventListener('blur', () => setTimeout(() => email.value = 'stale@fixture.test', 250), {once:true});</script></form>`);
  result = await fillApplication(page, profile, {});
  assert.equal(await page.locator('#email').inputValue(), profile.email, 'Recover delayed property-only resets');
  assert.deepEqual(result.missing, []);

  await page.setContent(`<form><label for="email">Email</label><input id="email" value="${profile.email}" required>
    <label for="last">Last name</label><input id="last" required>
    <label for="phone">Phone</label><input id="phone" value="${profile.phone}" required>
    <script>
      last.addEventListener('blur', () => email.value = 'stale@fixture.test', {once:true});
      email.addEventListener('blur', () => phone.value = 'old phone', {once:true});
      phone.addEventListener('blur', () => last.value = 'old name', {once:true});
    </script></form>`);
  result = await fillApplication(page, profile, {});
  assert.equal(await page.locator('#email').inputValue(), profile.email);
  assert.equal(await page.locator('#last').inputValue(), profile.lastName);
  assert.equal(await page.locator('#phone').inputValue(), profile.phone);
  assert.deepEqual(result.missing, [], 'Keep auditing after cascading recovery interactions');

  await page.setContent('<form><label for="consent">Receive updates?</label><input id="consent" type="checkbox"></form>');
  result = await fillApplication(page, profile, { 'Receive updates?': 'No' });
  assert.deepEqual(result.missing, [], 'An unchecked optional checkbox verifies an approved No');
  assert.equal(await page.locator('#consent').isChecked(), false);
  await page.locator('#consent').evaluate(el => el.required = true);
  result = await fillApplication(page, profile, { 'Receive updates?': 'No' });
  assert.ok(result.missing.some(field => field.id === 'consent' || field.type === 'validation'), 'Native required consent still needs human review');

  await page.setContent(`<form><div class="file-upload"><label for="resume">Resume</label>
    <input id="resume" type="file" required><span data-automation-id="file-upload-successful">old-resume.pdf</span></div>
    <label for="email">Email</label><input id="email" required></form>`);
  await page.locator('#resume').evaluate(el => el.addEventListener('change', () => {
    window.uploaded = el.files[0].name;
    el.parentElement.querySelector('span').textContent = el.files[0].name;
  }));
  result = await fillApplication(page, profile, {});
  assert.equal(await page.evaluate(() => window.uploaded), 'test-verification-engine.mjs', 'Replace an old accepted resume with the requested file');
  assert.equal(result.resumeUploaded, true);
  assert.deepEqual(result.missing, []);
  await page.evaluate(() => window.uploaded = null);
  result = await fillApplication(page, profile, {});
  assert.equal(await page.evaluate(() => window.uploaded), null, 'Reuse the exact accepted resume without uploading it again');
  assert.equal(result.resumeUploaded, true);

  await page.setContent(`<form><div class="file-upload"><label for="resume">Resume</label>
    <input id="resume" type="file" required><span></span></div>
    <label for="email">Email</label><input id="email" required></form>`);
  await page.locator('#resume').evaluate(el => el.addEventListener('change', () => {
    el.parentElement.querySelector('span').textContent = el.files[0].name;
    setTimeout(() => {
      const error = document.createElement('div'); error.setAttribute('role', 'alert');
      error.textContent = 'Upload rejected'; el.parentElement.append(error);
    }, 250);
  }));
  result = await fillApplication(page, profile, {});
  assert.equal(result.resumeUploaded, false, 'Read back upload state again after the form settles');
  assert.ok(result.missing.some(field => field.type === 'file'));
  assert.ok(!result.filled.includes('Resume'), 'Late rejected attachments cannot count as verified');

  await page.setContent('<form><label for="email">Email</label><input id="email" required></form>');
  await page.evaluate(() => { window.churn = setInterval(() => { email.value = String(Date.now()); }, 60); });
  result = await fillApplication(page, profile, {});
  await page.evaluate(() => clearInterval(window.churn));
  assert.ok(result.missing.some(field => field.type === 'recovery'), 'Unstable forms stop for review within a bounded wait');

  assert.equal(await page.evaluate(() => window.submitted || false), false);
  assert.equal(requests, 0);
  console.log('PASS: delayed conditionals and resets, approved unchecked answers, required consent validation, exact existing resume, late upload rejection, bounded unstable-form handoff, no external requests or submission.');
} finally { await browser.close(); }
