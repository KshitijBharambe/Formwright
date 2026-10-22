import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { getAnswer, resolveApprovedAnswer } from '../dist/answers.js';
import { fillApplication } from '../dist/form.js';

const profile = { firstName: 'Alex', lastName: 'Example', fullName: 'Alex Example', email: 'alex@example.test', phone: '5555550100', resumePath: import.meta.filename };
const nyc = 'Are you comfortable working out of our NYC office 4 days a week?';
const variant = 'Are you able to work from our New York City office four days per week?';
const sf = 'We are based in downtown San Francisco and require in-person attendance five days per week. Are you able to meet this requirement?';
const sponsorship = 'Do you now or in the future require visa sponsorship to work in the United States?';
const bank = { [nyc]: 'Yes', [sf]: 'No', [sponsorship]: 'Yes' };
assert.equal(getAnswer(variant, profile, bank), 'Yes');
assert.equal(getAnswer('Are you willing to work in the downtown San Francisco office 5 days a week?', profile, bank), 'No');
assert.equal(getAnswer('Will you require visa sponsorship now or in the future to work in the United States?', profile, bank), 'Yes');
assert.equal(resolveApprovedAnswer(variant, { ...bank, [variant]: 'No' }).status, 'conflict');
for (const question of [
  nyc.replace('4', '5'), nyc.replace('NYC', 'San Francisco'), nyc.replace('NYC', 'London'),
  nyc.replace('comfortable', 'not comfortable'), nyc.replace('4 days', 'at least 4 days'),
  `${variant} You must relocate before starting.`,
  variant.replace('four days per week', 'four days per week including weekends'),
  'Are you willing to relocate?', 'Are you open to remote work?',
  'Are you able to work from our San Francisco office five days per week?',
  'Do you currently require visa sponsorship to work in the United States?',
  sponsorship.replace('United States', 'Canada')
]) assert.equal(getAnswer(question, profile, bank), undefined, question);
assert.equal(getAnswer(nyc, profile, { 'Are you willing to relocate?': 'Yes' }), undefined);
assert.equal(getAnswer(sponsorship, profile, { 'Will you now or in the future require employment sponsorship?': 'Yes' }), undefined);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  let network = 0, submissions = 0;
  await page.route('**/*', route => { network++; return route.abort(); });
  await page.exposeFunction('recordSubmission', () => submissions++);
  for (const shape of ['styled', 'radio', 'pressed', 'select', 'listbox', 'multi']) {
    const options = ['Yes', 'No'];
    let control;
    if (shape === 'styled') control = `<div><div>${variant} *</div><div>${options.map(value => `<label><input type="radio" name="office" value="${value}" style="display:none" ${value === 'No' ? 'checked' : ''}>${value}</label>`).join('')}</div></div>`;
    if (shape === 'radio') control = `<div role="radiogroup" aria-label="${variant}" aria-required="true">${options.map(value => `<button type="button" role="radio" aria-checked="${value === 'No'}">${value}</button>`).join('')}</div>`;
    if (shape === 'pressed') control = `<fieldset><legend>${variant} *</legend>${options.map(value => `<button type="button" aria-pressed="${value === 'No'}">${value}</button>`).join('')}</fieldset>`;
    if (shape === 'select' || shape === 'multi') control = `<label for="office">${variant} *</label><select id="office" required ${shape === 'multi' ? 'multiple' : ''}>${options.map(value => `<option ${value === 'No' ? 'selected' : ''}>${value}</option>`).join('')}</select>`;
    if (shape === 'listbox') control = `<div role="listbox" aria-label="${variant}" aria-required="true">${options.map(value => `<div role="option" aria-selected="${value === 'No'}">${value}</div>`).join('')}</div>`;
    await page.setContent(`<form>${control}<button type="submit">Submit</button></form>`);
    await page.evaluate(() => {
      document.querySelector('form').onsubmit = event => { event.preventDefault(); window.recordSubmission(); };
      document.querySelectorAll('[aria-checked],[aria-pressed],[aria-selected]').forEach(control => control.onclick = () => {
        const attr = control.hasAttribute('aria-pressed') ? 'aria-pressed' : control.hasAttribute('aria-checked') ? 'aria-checked' : 'aria-selected';
        if (attr !== 'aria-pressed') control.parentElement.querySelectorAll(`[${attr}]`).forEach(option => option.setAttribute(attr, 'false'));
        control.setAttribute(attr, String(control.getAttribute(attr) !== 'true'));
      });
    });
    const result = await fillApplication(page, profile, bank);
    assert.deepEqual(result.missing, [], shape);
    assert.equal(result.filled.length, 1, shape);
    assert.deepEqual((await fillApplication(page, profile, bank)).filled, [], `${shape} rerun`);
    const unknown = await fillApplication(page, profile, {});
    assert.equal(unknown.filled.length, 0, `${shape} no inferred preference`);
  }
  assert.equal(network, 0);
  assert.equal(submissions, 0);
  console.log('PASS: office location/schedule boundaries, US sponsorship wording, conflicts, six control shapes, committed readback, reruns, and no network/submissions.');
} finally { await browser.close(); }
