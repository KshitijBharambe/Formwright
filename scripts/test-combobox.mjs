import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fillApplication } from '../dist/form.js';
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage();
  await page.setContent(`<form>
    <label for="country">Country*</label><div class="select__control"><span class="select__single-value">United States</span><input id="country" role="combobox" aria-expanded="false"></div>
    <label for="candidate-location">Location (City)*</label><div class="select__control"><span class="select__single-value">Syracuse, New York, United States</span><input id="candidate-location" role="combobox" aria-expanded="false"></div>
  </form>`);
  const result = await fillApplication(page, {resumePath:import.meta.filename,city:'Syracuse',state:'NY',country:'United States'}, {});
  assert.deepEqual(result.missing.filter(f=>f.type==='combobox'), [], 'Committed comboboxes must not be reported missing');
  await page.locator('.select__single-value').evaluateAll(els => els.forEach(el => el.remove()));
  await page.locator('#country').fill('United States');
  await page.locator('#country').evaluate(el => el.setAttribute('aria-expanded', 'true'));
  await page.locator('#candidate-location').fill('Syracuse');
  const unresolved = await fillApplication(page, {resumePath:import.meta.filename}, {});
  assert.equal(unresolved.missing.filter(f=>f.type==='combobox').length, 2, 'Uncommitted query text must remain unresolved');
  console.log('Committed selection and uncommitted query regressions passed.');
} finally { await browser.close(); }
