import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { configuredATS, matchesUrl, annotateFields, detectFrameATS, adapterControl, adapters } from '../dist/simplify.js';
import { jobKey } from '../dist/detect.js';
import { fieldAnswer } from '../dist/profile-values.js';
import { fillApplication } from '../dist/form.js';
import { fillJourney } from '../dist/journey.js';
const profile = { firstName: 'Alex', lastName: 'Test', fullName: 'Alex Test', email: 'alex@example.com', resumePath: import.meta.filename };
assert.equal(Object.keys(adapters()).length >= 50, true);
assert.equal(configuredATS('https://jobs.ashbyhq.com/example/123'), 'AshbyHQ');
assert.equal(configuredATS('https://example.myworkdayjobs.com/en-US/jobs/job/123'), 'Workday');
assert.equal(matchesUrl('*://jobs.lever.co/*', 'https://jobs.lever.co.evil.invalid/company/job'), false);
assert.equal(jobKey('https://example.com/job?reqId=10&utm_source=test&c=2'), 'https://example.com/job?c=2&reqId=10');
assert.equal(fieldAnswer({ label: 'Opaque prompt', semanticKey: 'sponsorship' }, profile, {}), undefined);
assert.equal(fieldAnswer({ label: 'Opaque prompt', semanticKey: 'sponsorship' }, { ...profile, autofill: { sponsorship: 'Yes' } }, {}), 'Yes');
assert.equal(matchesUrl('*://*.myworkdayjobs.com/*', 'https://evil.invalid/path.myworkdayjobs.com/job'), false);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  // No employer requests, even if a fixture accidentally adds a URL.
  await page.route('**/*', route => route.abort());
  await page.setContent(`<meta property="og:url" content="https://jobs.ashbyhq.com/example/123/application"><div aria-labelledby="job-application-form">
    <div class="fieldEntry"><label for="n" class="question-title">Candidate identity *</label><input type="text" id="n" name="_systemfield_name" required></div>
    <div class="fieldEntry"><label for="e" class="question-title">Contact *</label><input type="text" id="e" name="_systemfield_email" required></div>
    <div class="fieldEntry"><label for="r">Resume</label><input type="file" id="r" name="_systemfield_resume"></div>
    <div class="fieldEntry"><label for="q" class="question-title">Why this position? *</label><textarea id="q" required></textarea></div>
    <button class="ashby-application-form-submit-button" onclick="window.submits=(window.submits||0)+1">Submit</button></div>`);
  assert.equal(await detectFrameATS(page.mainFrame()), 'AshbyHQ');
  await annotateFields(page.mainFrame(), 'AshbyHQ');
  assert.equal(await page.locator('#n').getAttribute('data-ap-key'), 'full_name', 'String selector alternatives must work');
  const result = await fillApplication(page.mainFrame(), profile, {}, 'AshbyHQ');
  assert.equal(await page.locator('#n').inputValue(), 'Alex Test');
  assert.equal(await page.locator('#e').inputValue(), profile.email);
  assert.equal(await page.locator('#r').evaluate(el => el.files.length), 1);
  assert.ok(result.missing.some(f => /Why this position/.test(f.label)));
  assert.equal(await page.evaluate(() => window.submits || 0), 0);
  const answered = await fillApplication(page.mainFrame(), profile, { 'Why this position?': 'An approved answer.' }, 'AshbyHQ');
  assert.equal(await page.locator('#q').inputValue(), 'An approved answer.');
  assert.equal(answered.missing.length, 0);
  assert.ok(await adapterControl(page.mainFrame(), 'AshbyHQ', 'submit'));
  // ARIA-associated options must win over an unrelated, simultaneously open menu.
  await page.setContent(`<form><label for="country">Country *</label>
    <div class="select__control"><input role="combobox" id="country" aria-controls="mine" aria-expanded="true"><span class="select__single-value"></span></div>
    <div id="mine" role="listbox"><div role="option" onclick="document.querySelector('.select__single-value').textContent='Canada';document.querySelector('#country').setAttribute('aria-expanded','false')">Canada</div></div>
    <div role="listbox"><div role="option" onclick="window.wrong=true">Canada</div></div></form>`);
  const dropdown = await fillApplication(page.mainFrame(), { ...profile, country: 'Canada' }, {});
  assert.equal(await page.evaluate(() => window.wrong || false), false);
  assert.equal(dropdown.missing.filter(f => f.type === 'combobox').length, 0);
  // Incorrect prefilled values are corrected from the approved profile.
  await page.setContent('<form><label for="email">Email</label><input id="email" type="email" value="bad-address" required></form>');
  const corrected = await fillApplication(page.mainFrame(), profile, {});
  assert.equal(await page.locator('#email').inputValue(), profile.email);
  assert.deepEqual(corrected.missing, []);
  // A real validation rejection of a nonempty approved value prevents readiness.
  await page.locator('#email').evaluate(el => el.setAttribute('pattern', '.+@employer[.]invalid'));
  const invalid = await fillApplication(page.mainFrame(), profile, {});
  assert.ok(invalid.missing.some(f => f.type === 'validation'));
  // A two-step Workday-like form tests the actual continuation interpreter.
  await page.setContent(`<main><h2>Contact</h2><div data-automation-id="formField-name"><input type="text" data-automation-id="name" required></div>
    <button data-automation-id="bottom-navigation-next-button">Save and Continue</button></main>`);
  await page.evaluate(() => {
    document.querySelector('button').addEventListener('click', () => {
      document.querySelector('main').innerHTML = `<h2>Application</h2><div data-automation-id="formField-email"><label for="email">Email</label><input id="email" data-automation-id="email" required></div><button data-automation-id="bottom-navigation-next-button">Submit</button>`;
      document.querySelector('button').addEventListener('click', () => { window.submits = 1; });
    });
  });
  const journey = await fillJourney(page, page.mainFrame(), profile, {}, 'Workday', true, 3);
  assert.equal(journey.steps, 2, JSON.stringify({ missing: journey.missing, filled: journey.filled }));
  assert.equal(await page.locator('#email').inputValue(), profile.email);
  assert.equal(await page.evaluate(() => window.submits || 0), 0);
  console.log('PASS: imported selectors, embedded detection, approved answers, upload, scoped dropdowns, invalid values, and multi-step fill without submission.');
} finally { await browser.close(); }
