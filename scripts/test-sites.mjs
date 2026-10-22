import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { detectATS } from '../dist/detect.js';
import { openApplication, ApplicationHandoff } from '../dist/application-entry.js';
import { findApplicationScope } from '../dist/form-detection.js';
import { fillJourney } from '../dist/journey.js';
import { submitAndVerify } from '../dist/form.js';
import { submissionMessages } from '../dist/confirmation.js';
import { boardFromUrl } from '../dist/sites.js';

const profile = { firstName: 'Alex', lastName: 'Example', fullName: 'Alex Example', email: 'alex@example.com', phone: '+15555550100', resumePath: import.meta.filename };
const fields = '<label for="first_name">First name</label><input id="first_name" name="first_name" required><label for="last_name">Last name</label><input id="last_name" name="last_name" required><label for="email">Email</label><input type="email" id="email" name="email" required>';
const pages = new Map([
  ['https://boards.greenhouse.io/example/jobs/1', `<form id="application"><h2>Apply for this job</h2>${fields}<button type="button">Submit application</button></form>`],
  ['https://jobs.lever.co/example/1/apply', `<form><h2>Apply for this job</h2>${fields}<button type="button" id="btn-submit">Submit application</button></form>`],
  ['https://jobs.ashbyhq.com/example/1/application', `<form><h2>Apply for this job</h2>${fields}<button type="button" class="ashby-application-form-submit-button">Submit application</button></form>`],
  ['https://example.myworkdayjobs.com/en-US/jobs/job/1', `<main><h2>Apply for this job</h2>${fields}<button type="button" data-automation-id="bottom-navigation-next-button">Submit</button></main>`],
  ['https://www.linkedin.com/jobs/view/1', `<label for="background-email">Email</label><input id="background-email"><button class="jobs-apply-button" onclick="document.querySelector('#modal').hidden=false;this.hidden=true">Easy Apply</button><div id="modal" class="jobs-easy-apply-modal" role="dialog" hidden><form><h2>Apply to Example</h2>${fields}<button type="button" aria-label="Submit application">Submit application</button></form></div>`],
  ['https://www.indeed.com/viewjob?jk=1', '<a id="indeedApplyButton" href="https://smartapply.indeed.com/beta/indeedapply/form/1" target="_blank">Apply now</a>'],
  ['https://smartapply.indeed.com/beta/indeedapply/form/1', `<div id="ia-container"><form><h2>Apply for this job</h2>${fields}<button type="button" data-testid="submit-application-button">Submit your application</button></form></div>`],
  ['https://www.ziprecruiter.com/c/Example/Job/Engineer', `<button data-testid="apply-button" onclick="document.querySelector('#modal').hidden=false;this.hidden=true">Quick Apply</button><div id="modal" role="dialog" hidden><form data-testid="apply-form"><h2>Apply for this job</h2>${fields}<button type="button" data-testid="application-submit">Submit application</button></form></div>`],
  ['https://www.linkedin.com/jobs/view/2', '<a class="jobs-apply-button" href="https://boards.greenhouse.io/example/jobs/1" target="_blank">Apply on company website</a>'],
  ['https://www.indeed.com/viewjob?jk=login', '<h1>Sign in</h1><input type="email"><input type="password">'],
  ['https://www.linkedin.com/jobs/search/', '<button onclick="window.clicked=true">Easy Apply</button>']
]);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
let unmocked = 0;
await context.route('**/*', route => {
  const body = pages.get(route.request().url());
  if (body) return route.fulfill({ contentType: 'text/html', body });
  unmocked++;
  return route.abort();
});
try {
  for (const [url, expected] of [
    ['https://boards.greenhouse.io/example/jobs/1', 'Greenhouse'],
    ['https://jobs.lever.co/example/1/apply', 'Lever'],
    ['https://jobs.ashbyhq.com/example/1/application', 'AshbyHQ'],
    ['https://example.myworkdayjobs.com/en-US/jobs/job/1', 'Workday'],
    ['https://www.linkedin.com/jobs/view/1', 'LinkedIn'],
    ['https://www.indeed.com/viewjob?jk=1', 'Indeed'],
    ['https://www.ziprecruiter.com/c/Example/Job/Engineer', 'ZipRecruiter'],
    ['https://www.linkedin.com/jobs/view/2', 'Greenhouse']
  ]) {
    const page = await context.newPage();
    page.setDefaultTimeout(2500);
    await page.goto(url);
    const entry = await openApplication(page, detectATS(url));
    assert.equal(entry.ats, expected, url);
    const scope = await findApplicationScope(entry.page, 2000, entry.ats);
    assert.ok(scope, `${url}: application scope`);
    const result = await fillJourney(entry.page, scope, profile, {}, entry.ats, true, 4);
    assert.equal(await entry.page.locator('#first_name').inputValue(), profile.firstName, url);
    assert.equal(await entry.page.locator('#email').inputValue(), profile.email, url);
    assert.deepEqual(result.missing, [], `${url}: missing fields`);
    assert.equal((await submissionMessages(result.scope)).length, 0);
    if (expected === 'LinkedIn') assert.equal(await page.locator('#background-email').inputValue(), '', 'Never fill outside the application dialog');
    console.log(`PASS: ${url} -> ${expected}`);
    await entry.page.close();
    if (entry.page !== page) await page.close();
  }
  for (const [url, ats, wrapper, submitAttr] of [
    ['https://www.linkedin.com/jobs/view/3', 'LinkedIn', 'class="jobs-easy-apply-modal" role="dialog"', 'aria-label="Submit application"'],
    ['https://smartapply.indeed.com/beta/indeedapply/form/3', 'Indeed', 'id="ia-container"', 'data-testid="submit-application-button"'],
    ['https://www.ziprecruiter.com/c/Example/Job/Review', 'ZipRecruiter', 'role="dialog"', 'data-testid="application-submit"']
  ]) {
    pages.set(url, `<div ${wrapper}><form><h2>Contact information</h2>${fields}<button type="button" id="next" data-testid="continue-button">Next</button></form></div>`);
    const page = await context.newPage();
    await page.goto(url);
    await page.locator('#next').evaluate((el, attr) => el.addEventListener('click', () => {
      el.parentElement.parentElement.innerHTML = `<h2>Review your application</h2><button type="button" ${attr}>Submit application</button>`;
    }), submitAttr);
    const entry = await openApplication(page, ats);
    const scope = await findApplicationScope(page, 2000, ats);
    const journey = await fillJourney(page, scope, profile, {}, ats, true, 4);
    assert.equal(journey.steps, 2, ats);
    assert.deepEqual(journey.missing, [], ats);
    assert.equal(await page.getByRole('button', { name: 'Submit application', exact: true }).count(), 1);
    assert.deepEqual(await submissionMessages(journey.scope), []);
    await page.close();
    console.log(`PASS: ${ats} multi-step review with no remaining inputs`);
  }
  const login = await context.newPage();
  await login.goto('https://www.indeed.com/viewjob?jk=login');
  await assert.rejects(openApplication(login, 'Indeed'), err => err instanceof ApplicationHandoff && err.reason === 'login');
  assert.equal(await login.locator('input[type=email]').inputValue(), '');
  let handoffs = 0;
  const resumed = await openApplication(login, 'Indeed', async (activePage, handoff) => {
    assert.equal(handoff.reason, 'login'); handoffs++;
    await activePage.setContent(`<div id="ia-container"><form><h2>Apply for this job</h2>${fields}<button data-testid="submit-application-button">Submit your application</button></form></div>`);
  });
  assert.equal(resumed.ats, 'Indeed');
  assert.equal(handoffs, 1);
  const search = await context.newPage();
  await search.goto('https://www.linkedin.com/jobs/search/');
  await assert.rejects(openApplication(search, 'LinkedIn'), err => err instanceof ApplicationHandoff && err.reason === 'navigation');
  assert.equal(await search.evaluate(() => window.clicked || false), false);
  assert.equal(boardFromUrl('https://linkedin.com.evil.invalid/jobs/view/1'), null);
  // Generic JSON-LD and success-looking icons must never establish submission.
  const confirmation = await context.newPage();
  await confirmation.setContent('<script type="application/ld+json">{"@type":"JobPosting"}</script><h2>Apply for this job</h2><div role="dialog"><svg class="wd-icon-check-circle"></svg></div>');
  assert.deepEqual(await submissionMessages(confirmation.mainFrame()), []);
  // Explicit submission is exercised only against a local synthetic button.
  await confirmation.setContent('<form><button type="button" onclick="document.body.innerHTML=\'<h2>Your application has been submitted</h2>\'">Submit application</button></form>');
  assert.equal(await submitAndVerify(confirmation.mainFrame()), true);
  assert.equal(unmocked, 0, 'All fixture navigation must stay mocked');
  console.log('PASS: login handoff, search-page rejection, hostname boundaries, and explicit confirmation.');
} finally { await context.close(); await browser.close(); }
