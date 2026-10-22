import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { getAnswer } from '../dist/answers.js';
import { fieldAnswer } from '../dist/profile-values.js';
import { resolveOption, chosenOption } from '../dist/field-matching.js';
import { fillApplication } from '../dist/form.js';
import { fillWorkdayPrompt, annotateWorkday } from '../dist/workday-controls.js';

const profile = { firstName: 'Alex', lastName: 'Example', fullName: 'Alex Example', email: 'alex@example.com', phone: '5555550100', resumePath: import.meta.filename };
const bank = { 'Degree type': 'Masters of Science' };
for (const label of ['Degree *', 'Academic degree (required)', 'Type of degree']) {
  assert.equal(getAnswer(label, profile, bank), 'Masters of Science');
  assert.equal(chosenOption(["Bachelor's degree", 'Master’s degree', 'Doctorate'], fieldAnswer({ label, kind: 'select' }, profile, bank), label), 'Master’s degree');
}
assert.equal(fieldAnswer({ label: 'Academic degree', kind: 'combobox' }, profile, { 'What degree do you hold?': 'Master of Science' }), 'Master of Science');
assert.equal(fieldAnswer({ label: 'University name (required)', kind: 'text' }, { ...profile, education: [{ school: 'Example University' }] }, {}), 'Example University');
assert.equal(getAnswer('What is your highest level of education?', profile, { 'Highest degree earned': 'Master of Science' }), 'Master of Science');
assert.equal(getAnswer('Highest degree earned', profile, { 'What degree do you hold?': 'Master of Science' }), undefined, 'Holding a degree is separate from a highest/completed-degree claim');
assert.equal(getAnswer('Degree', profile, { 'Degree type': 'Master of Science', 'Academic degree': 'Master of Arts' }), undefined);
assert.equal(fieldAnswer({ label: 'Degree', kind: 'select' }, { ...profile, education: [{ school: 'Example', degree: 'Master of Science' }] }, { 'Degree type': 'Master of Science', 'Academic degree': 'Master of Arts' }), undefined, 'Conflicts must not fall through to another source');
assert.equal(getAnswer('What is your first name? (required)', profile, {}), 'Alex');
assert.equal(getAnswer('What is your phone number?', profile, { 'Phone number': '5555550200' }), '5555550200');
assert.equal(getAnswer('What is your email address?', profile, {}), profile.email);
for (const label of ['Are you currently pursuing a master’s degree?', 'Do you have a degree?', 'Highest degree planned', 'Major']) {
  assert.equal(getAnswer(label, profile, bank), undefined);
  assert.equal(chosenOption(["Master's degree"], 'Master of Science', label), undefined);
}
const cases = [
  ['Master of Science', ['M.Sc.', "Master's degree"], 'M.Sc.'],
  ['M.S.', ['Master of Science (MS)', "Master's degree"], 'Master of Science (MS)'],
  ['Master of Engineering', ['MEng'], 'MEng'],
  ['Bachelor of Engineering', ["Bachelor's Degree", 'Master of Science'], "Bachelor's Degree"],
  ['Ph.D.', ['Doctorate'], 'Doctorate'],
  ['Master of Science', ['Master of Arts'], undefined],
  ["Master's degree", ['Master of Science'], undefined],
  ['Master of Science', ['Master of Science in Data Science'], undefined],
  ['Master of Science', ["Bachelor's degree"], undefined],
  ['Master of Science', ["Master's degree or higher"], undefined],
  ['Master of Science', ["Master's degree", 'Masters'], undefined],
  ['Master of Science', ['MS', 'MSc', "Master's degree"], undefined],
  ['Master of Science', ['Master of Science', 'Master of Science', "Master's degree"], undefined]
];
for (const [answer, options, expected] of cases) assert.equal(chosenOption(options, answer, 'Academic degree (required)'), expected, JSON.stringify({ answer, options }));
assert.deepEqual(resolveOption(["Master's degree"], 'Master of Science', 'Degree'), { status: 'matched', option: "Master's degree", method: 'generalized' });
assert.equal(resolveOption(['MS', 'MSc'], 'Master of Science', 'Degree').status, 'ambiguous');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(1500);
  let requests = 0;
  await page.route('**/*', route => { requests++; return route.abort(); });
  const select = (id, label, options) => `<label for="${id}">${label}</label><select id="${id}" required><option value="">Choose</option>${options.map((text, i) => `<option value="v${i}">${text}</option>`).join('')}</select>`;
  await page.setContent(`<form>${select('degree', 'Academic degree (required)', ["Bachelor's degree", 'Master’s degree', 'Doctorate'])}<button type="button" onclick="window.submitted=true">Submit</button></form>`);
  let result = await fillApplication(page, profile, bank);
  assert.equal(await page.locator('#degree').inputValue(), 'v1');
  assert.deepEqual(result.missing, []);
  assert.deepEqual((await fillApplication(page, profile, bank)).filled, [], 'Equivalent committed selection should survive reruns');
  result = await fillApplication(page, profile, { 'Degree type': 'Master of Science', 'Academic degree': 'Master of Arts' });
  assert.ok(result.missing.some(field => field.id === 'degree'), 'A nonempty field cannot hide conflicting approved answers');

  await page.setContent(`<form><fieldset><legend>Type of degree *</legend><label><input type="radio" name="degree" value="b" required>Bachelor’s degree</label><label><input type="radio" name="degree" value="m" required>Master’s degree</label></fieldset></form>`);
  result = await fillApplication(page, profile, bank);
  assert.equal(await page.locator('[value=m]').isChecked(), true);
  assert.deepEqual(result.missing, []);

  await page.setContent('<form><label for="consent">Required consent *</label><input id="consent" type="checkbox" aria-required="true"></form>');
  result = await fillApplication(page, profile, { 'Required consent': 'No' });
  assert.ok(result.missing.some(field => field.id === 'consent'), 'Answer matching must preserve required-control checks');
  assert.equal(await page.locator('#consent').isChecked(), false);

  // A nonempty but incorrect selection must remain unresolved if no safe option exists.
  for (const options of [['Master of Arts'], ["Master's degree", 'Masters']]) {
    await page.setContent(`<form>${select('degree', 'Degree *', options)}</form>`);
    await page.locator('#degree').selectOption('v0');
    result = await fillApplication(page, profile, bank);
    assert.ok(result.missing.some(field => field.id === 'degree'));
    assert.deepEqual(result.filled, []);
  }

  // Search-only dropdown: the full bank value produces no results, "master"
  // discovers the actual option, and a click commits a separate display value.
  const combo = async ({ reject = false, ambiguous = false, filtered = true } = {}) => {
    await page.setContent(`<form><label for="degree">Academic degree *</label><div class="select__control"><input id="degree" role="combobox" aria-expanded="false" aria-controls="choices"></div><div id="choices" role="listbox"></div><button type="button" onclick="window.submitted=true">Submit</button></form>`);
    await page.evaluate(({ reject, ambiguous, filtered }) => {
      const input = document.querySelector('#degree');
      const menu = document.querySelector('#choices');
      window.queries = [];
      const render = () => {
        window.queries.push(input.value);
        input.setAttribute('aria-expanded', 'true');
        menu.replaceChildren();
        if (filtered && input.value.toLowerCase() !== 'master') return;
        for (const text of ambiguous ? ["Master's degree", 'Masters'] : ["Master's degree"]) {
          const option = document.createElement('div');
          option.setAttribute('role', 'option'); option.textContent = text;
          option.onclick = () => {
            menu.replaceChildren(); input.value = ''; input.setAttribute('aria-expanded', 'false');
            if (!reject) {
              const selected = document.createElement('span'); selected.className = 'select__single-value'; selected.textContent = text; input.before(selected);
            }
          };
          menu.append(option);
        }
      };
      input.addEventListener('click', render); input.addEventListener('input', render);
      input.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.replaceChildren(); input.setAttribute('aria-expanded', 'false'); } });
    }, { reject, ambiguous, filtered });
  };
  await combo();
  result = await fillApplication(page, profile, bank);
  assert.equal(await page.locator('.select__single-value').textContent(), "Master's degree");
  assert.ok((await page.evaluate(() => window.queries)).includes('master'));
  assert.deepEqual(result.missing, []);
  assert.deepEqual((await fillApplication(page, profile, bank)).filled, []);

  await combo({ reject: true, filtered: false });
  result = await fillApplication(page, profile, bank);
  assert.ok(result.missing.some(field => field.id === 'degree'), 'A click without a committed selection must remain unresolved');
  assert.deepEqual(result.filled, []);
  await combo({ ambiguous: true, filtered: false });
  result = await fillApplication(page, profile, bank);
  assert.ok(result.missing.some(field => field.id === 'degree'));
  assert.equal(await page.locator('#degree').inputValue(), '');
  assert.equal(await page.locator('.select__single-value').count(), 0);
  await page.setContent('<form><label for="query">Unknown required question *</label><input id="query" role="combobox" aria-expanded="false" value="Uncommitted text"></form>');
  result = await fillApplication(page, profile, {});
  assert.ok(result.missing.some(field => field.id === 'query'), 'A closed dropdown with query text alone is not committed');

  // Workday prompt menus use the same resolver as ordinary dropdowns.
  await page.setContent('<div data-automation-id="formField-degree"><label>Degree *</label><button id="wd" aria-haspopup="listbox">Select One</button></div><div role="listbox" id="menu" hidden><div role="option">Master’s degree</div></div>');
  await page.evaluate(() => {
    const button = document.querySelector('#wd'), menu = document.querySelector('#menu');
    button.onclick = () => { menu.hidden = false; };
    menu.firstElementChild.onclick = () => { button.textContent = menu.firstElementChild.textContent; menu.hidden = true; };
  });
  await annotateWorkday(page.mainFrame());
  assert.equal(await fillWorkdayPrompt(page.mainFrame(), page.locator('#wd'), 'Master of Science', 'Degree'), true);
  assert.equal(await page.locator('#wd').textContent(), 'Master’s degree');
  assert.equal(requests, 0);
  assert.equal(await page.evaluate(() => window.submitted || false), false);
  console.log('PASS: equivalent questions, specific/general degree matching, ambiguity, native/radio/search dropdowns, rejected selections, reruns, and Workday prompts; no network or submissions.');
} finally { await browser.close(); }
