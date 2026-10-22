import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openApplication } from '../dist/application-entry.js';
import { findApplicationScope } from '../dist/form-detection.js';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `
    <meta property="og:url" content="https://jobs.ashbyhq.com/example/id">
    <main><h1>Backend Engineer</h1><p>Benefits</p>
    <button onclick="document.querySelector('#application').hidden=false;this.hidden=true;window.entryClicked=true">Apply for this Job</button>
    <div id="application" hidden><form aria-labelledby="job-application-form">
    <h2 id="job-application-form">Application</h2>
    <div class="fieldEntry"><label for="_systemfield_name">Name</label><input id="_systemfield_name" name="name"></div>
    <div class="fieldEntry"><label for="_systemfield_email">Email</label><input id="_systemfield_email" type="email"></div>
    <button class="ashby-application-form-submit-button" type="button" onclick="window.submitted=true">Submit Application</button>
    </form></div></main>` }));
  await page.goto('https://jobs.ashbyhq.com/example/id');
  const entry = await openApplication(page, 'AshbyHQ');
  assert.equal(await page.evaluate(() => window.entryClicked || false), true, 'Must click Apply before accepting a hidden form');
  assert.equal(await page.locator('#_systemfield_name').isVisible(), true);
  assert.ok(await findApplicationScope(entry.page, 1000, entry.ats));
  assert.equal(await page.evaluate(() => window.submitted || false), false);
  console.log('PASS: Ashby listing opens its hidden application without submitting.');
  // Two genuinely separate Apply actions still require manual review. A nested
  // button/link pair is one action and must route successfully without rules.
  const nested = await browser.newPage();
  await nested.route('**/*', route => {
    const url=route.request().url();
    return route.fulfill({ contentType:'text/html', body: url.includes('jobs.ashbyhq.com')
      ? '<h2>Apply for this job</h2><label>First name<input id="first_name"></label><label>Last name<input id="last_name"></label><label>Email<input id="email" type="email"></label>'
      : '<h1>Backend Engineer</h1><a href="https://jobs.ashbyhq.com/example/next/application"><button>Apply for this Job</button></a>' });
  });
  await nested.goto('https://employer.example/jobs/1');
  const routed = await openApplication(nested, null);
  assert.equal(routed.ats, 'AshbyHQ');
  assert.ok(routed.page.url().includes('/application'));
  console.log('PASS: unknown employer listing with a nested Apply button/link reaches the ATS.');

} finally { await browser.close(); }
