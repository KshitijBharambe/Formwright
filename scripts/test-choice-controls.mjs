import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fillApplication } from '../dist/form.js';
import { getAnswer } from '../dist/answers.js';
import { chosenOption } from '../dist/field-matching.js';

const profile = { firstName: 'Alex', lastName: 'Example', fullName: 'Alex Example', email: 'alex@example.com', phone: '5555550100', resumePath: import.meta.filename };
const sponsorship = 'Will you now or in the future require employment sponsorship?';
const variant = 'Will you require visa sponsorship now or in the future?';
const bank = { [sponsorship]: 'Yes, I will require employer sponsorship in the future.' };
for (const question of [variant, 'Do you now or will you in the future require visa sponsorship?', 'Will you now or at any time in the future require visa sponsorship?']) {
  assert.equal(getAnswer(question, profile, bank), bank[sponsorship]);
}
for (const question of ['Do you currently require visa sponsorship?', 'Will you require visa sponsorship in the future?', 'Will you NOT require visa sponsorship?', 'Will you now or in the future require sponsorship to work in Canada?', 'Are you a US citizen?', 'Are you authorized to work without sponsorship?']) {
  assert.equal(getAnswer(question, profile, bank), undefined, question);
}
assert.equal(chosenOption(['True', 'False'], 'Yes', sponsorship), 'True');
assert.equal(chosenOption(['Y', 'N'], 'No', sponsorship), 'N');
assert.equal(chosenOption(['True', 'Y'], 'Yes', sponsorship), undefined);
assert.equal(chosenOption(['Yes, but only if eligible', 'No'], 'Yes', sponsorship), undefined);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(1800);
  let requests = 0, submissions = 0, cases = 0;
  await page.route('**/*', route => { requests++; return route.abort(); });
  await page.exposeFunction('recordSubmission', () => submissions++);
  const load = async html => {
    await page.setContent(html);
    await page.evaluate(() => {
      window.clicks = 0;
      document.addEventListener('click', () => window.clicks++);
      document.querySelectorAll('form').forEach(form => form.addEventListener('submit', event => { event.preventDefault(); window.recordSubmission(); }));
    });
  };
  const fill = async (answers = bank, customProfile = profile) => { cases++; return fillApplication(page, customProfile, answers); };
  const native = (type, name, text, extra = '') => `<label><input type="${type}" name="${name}" value="${text}" ${extra}>${text}</label>`;
  const custom = (role, text, state = 'false', extra = '') => `<button type="button" role="${role}" aria-${role === 'option' ? 'selected' : 'checked'}="${state}" ${extra}>${text}</button>`;
  const radioBehavior = async ({ reject = false, rerender = false } = {}) => page.evaluate(({ reject, rerender }) => {
    document.querySelectorAll('[role=radiogroup]').forEach(group => {
      group.onclick = event => {
        const target = event.target.closest('[role=radio]');
        if (!target || reject) return;
        group.querySelectorAll('[role=radio]').forEach(option => option.setAttribute('aria-checked', String(option === target)));
        if (rerender) group.innerHTML = group.innerHTML;
      };
    });
  }, { reject, rerender });
  const toggleBehavior = async () => page.evaluate(() => {
    document.querySelectorAll('[role=group],fieldset,[role=listbox],form').forEach(group => {
      group.addEventListener('click', event => {
        if (event.defaultPrevented) return;
        const control = event.target.closest('[aria-checked],[aria-pressed],[aria-selected]');
        if (!control || control.getAttribute('aria-disabled') === 'true') return;
        event.preventDefault();
        const attr = control.hasAttribute('aria-pressed') ? 'aria-pressed' : control.hasAttribute('aria-selected') ? 'aria-selected' : 'aria-checked';
        if (attr === 'aria-selected' && group.getAttribute('aria-multiselectable') !== 'true') group.querySelectorAll('[role=option]').forEach(option => option.setAttribute(attr, 'false'));
        control.setAttribute(attr, String(control.getAttribute(attr) !== 'true'));
      });
    });
  });

  // Hidden styled native inputs with a visible label and a prefilled wrong answer.
  await load(`<form><fieldset><legend>${variant} *</legend>${native('radio', 'sponsor', 'Yes', 'style="display:none" required')}${native('radio', 'sponsor', 'No', 'checked style="display:none"')}</fieldset></form>`);
  assert.deepEqual((await fill()).missing, []);
  assert.equal(await page.locator('[value=Yes]').isChecked(), true);
  assert.deepEqual((await fill()).filled, []);

  // Reused names in distinct forms/questions must never share options or checked state.
  await load(`<form><fieldset><legend>${variant} *</legend>${native('radio', 'answer', 'Yes')}${native('radio', 'answer', 'No')}</fieldset></form><form><fieldset><legend>Are you willing to relocate? *</legend>${native('radio', 'answer', 'Yes')}${native('radio', 'answer', 'No')}</fieldset></form>`);
  assert.deepEqual((await fill({ ...bank, 'Are you open to relocation?': 'No' })).missing, []);
  assert.equal(await page.locator('form').nth(0).locator('[value=Yes]').isChecked(), true);
  assert.equal(await page.locator('form').nth(1).locator('[value=No]').isChecked(), true);

  // Accessible group label references, stateful button radios, DOM replacement, and reruns.
  await load(`<form><h3 id="q">${variant} *</h3><div role="radiogroup" aria-labelledby="q" aria-required="true">${custom('radio', 'True')}${custom('radio', 'False', 'true')}</div></form>`);
  await radioBehavior({ rerender: true });
  assert.deepEqual((await fill()).missing, []);
  assert.equal(await page.getByRole('radio', { name: 'True', exact: true }).getAttribute('aria-checked'), 'true');
  assert.deepEqual((await fill()).filled, []);

  for (const role of ['checkbox', 'switch']) {
    await load(`<form>${custom(role, variant, 'false', 'id="answer"')}</form>`);
    await toggleBehavior();
    assert.deepEqual((await fill()).missing, []);
    assert.equal(await page.locator('#answer').getAttribute('aria-checked'), 'true');
    assert.deepEqual((await fill({ [sponsorship]: 'No' })).missing, []);
    assert.equal(await page.locator('#answer').getAttribute('aria-checked'), 'false');
  }
  await load(`<form><button type="button" aria-label="${variant}" aria-pressed="false" id="toggle"></button></form>`);
  await toggleBehavior();
  assert.deepEqual((await fill()).missing, []);
  assert.equal(await page.locator('#toggle').getAttribute('aria-pressed'), 'true');

  // Explicit semantic config still works when a portal provides the semantic key.
  await load('<form><button type="button" role="switch" data-ap-key="customSponsorship" aria-label="Custom question" aria-checked="false"></button></form>');
  await toggleBehavior();
  assert.deepEqual((await fill({}, { ...profile, autofill: { customSponsorship: 'Yes. Explicitly approved.' } })).missing, []);
  assert.equal(await page.getByRole('switch').getAttribute('aria-checked'), 'true');

  const selections = { 'Preferred locations': '["New York, NY","Boston","Seattle"]' };
  for (const shape of ['native', 'aria', 'pressed', 'select', 'listbox']) {
    const options = ['New York, NY', 'Boston', 'Seattle', 'Other'];
    let html;
    if (shape === 'native') html = `<fieldset><legend>Preferred locations (select all that apply)</legend>${options.map(name => native('checkbox', 'locations', name, name === 'Other' ? 'checked' : '')).join('')}</fieldset>`;
    if (shape === 'aria') html = `<div role="group" aria-label="Preferred locations">${options.map(name => custom('checkbox', name, String(name === 'Other'))).join('')}</div>`;
    if (shape === 'pressed') html = `<div role="group" aria-label="Preferred locations">${options.map(name => `<button type="button" aria-pressed="${name === 'Other'}">${name}</button>`).join('')}</div>`;
    if (shape === 'select') html = `<label for="locations">Preferred locations</label><select multiple id="locations">${options.map(name => `<option ${name === 'Other' ? 'selected' : ''}>${name}</option>`).join('')}</select>`;
    if (shape === 'listbox') html = `<div role="listbox" aria-label="Preferred locations" aria-multiselectable="true">${options.map(name => custom('option', name, String(name === 'Other'))).join('')}</div>`;
    await load(`<form>${html}</form>`);
    if (['aria', 'pressed', 'listbox'].includes(shape)) await toggleBehavior();
    const result = await fill(selections);
    assert.deepEqual(result.missing, [], shape);
    assert.equal(result.filled.length, 1, shape);
    assert.deepEqual((await fill(selections)).filled, [], `${shape} idempotent`);
    const snapshot = await page.evaluate(() => window.clicks);
    const unknown = await fill({ 'Preferred locations': '["Boston","Unknown"]' });
    assert.equal(unknown.missing.length, 1, shape);
    assert.equal(await page.evaluate(() => window.clicks), snapshot, `${shape} no partial writes`);
    assert.deepEqual((await fill({ 'Preferred locations': '[]' })).missing, [], `${shape} explicit empty set`);
  }
  await load(`<form><div role="listbox" aria-label="${variant}">${custom('option', 'Yes')}${custom('option', 'No', 'true')}</div></form>`);
  await toggleBehavior();
  assert.deepEqual((await fill()).missing, []);
  assert.equal(await page.getByRole('option', { name: 'Yes', exact: true }).getAttribute('aria-selected'), 'true');

  // Group semantics outrank decorative option wrappers; owned radios need not be descendants.
  await load(`<form><fieldset><legend>${variant} *</legend><div class="field">${native('radio', 'wrapped', 'Yes')}</div><div class="field">${native('radio', 'wrapped', 'No')}</div></fieldset></form>`);
  assert.deepEqual((await fill()).missing, []);
  await load(`<form><div role="radiogroup" aria-label="${variant}" aria-owns="owned-yes owned-no"></div>${custom('radio', 'Yes', 'false', 'id="owned-yes"')}${custom('radio', 'No', 'false', 'id="owned-no"')}</form>`);
  await page.evaluate(() => document.querySelectorAll('[role=radio]').forEach(control => control.onclick = () => {
    document.querySelectorAll('[role=radio]').forEach(option => option.setAttribute('aria-checked', String(option === control)));
  }));
  assert.deepEqual((await fill()).missing, []);

  await load(`<form><fieldset><legend>Preferred locations</legend>${native('checkbox', 'locations', 'Boston')}${native('checkbox', 'locations', 'Other', 'style="display:none" required')}</fieldset></form>`);
  assert.equal((await fill({ 'Preferred locations': 'Boston' })).missing.length, 1, 'An unchecked hidden required option must fail validation');
  await load('<form><label for="locations">Preferred locations</label><select multiple id="locations"><option>Boston</option><optgroup disabled label="Unavailable"><option>Seattle</option></optgroup></select></form>');
  assert.equal((await fill({ 'Preferred locations': '["Boston","Seattle"]' })).missing.length, 1);
  assert.deepEqual(await page.locator('option:checked').allTextContents(), [], 'Disabled target prevents partial writes');

  await load('<form><div role="listbox" aria-label="Preferred locations" aria-multiselectable="true"><div role="option" aria-selected="true">Boston</div><div role="option" aria-selected="true" hidden>Other</div></div></form>');
  assert.equal((await fill({ 'Preferred locations': 'Boston' })).missing.length, 1, 'Hidden selected options cannot disappear from full-set verification');

  // No state, rejected clicks, mixed state, disabled options, and submit buttons fail closed.
  for (const scenario of ['reject', 'mixed', 'disabled', 'ambiguous', 'submit', 'input-submit', 'missing-state', 'two-selected']) {
    let content = custom('radio', 'Yes') + custom('radio', 'No');
    if (scenario === 'mixed') content = custom('radio', 'Yes', 'mixed') + custom('radio', 'No');
    if (scenario === 'disabled') content = custom('radio', 'Yes', 'false', 'disabled') + custom('radio', 'No');
    if (scenario === 'ambiguous') content += custom('radio', 'Yes');
    if (scenario === 'submit') content = '<button role="radio" aria-checked="false">Yes</button>' + custom('radio', 'No');
    if (scenario === 'input-submit') content = '<input type="submit" role="radio" aria-label="Yes" aria-checked="false">' + custom('radio', 'No');
    if (scenario === 'missing-state') content = '<div role="radio">Yes</div>' + custom('radio', 'No');
    if (scenario === 'two-selected') content = custom('radio', 'Yes', 'true') + custom('radio', 'No', 'true');
    await load(`<form><div role="radiogroup" aria-label="${variant}" aria-required="true">${content}</div></form>`);
    await radioBehavior({ reject: true });
    const result = await fill();
    assert.equal(result.missing.length, 1, scenario);
    assert.deepEqual(result.filled, [], scenario);
    if (!['reject', 'two-selected'].includes(scenario)) assert.equal(await page.evaluate(() => window.clicks), 0, scenario);
  }

  await load(`<form><div role="radiogroup" aria-label="${variant}">${custom('radio', 'Yes', 'true')}${custom('radio', 'No')}</div></form>`);
  assert.equal((await fill({ ...bank, [variant]: 'No' })).missing.length, 1, 'Optional conflicts cannot hide behind prefilled values');
  assert.equal(await page.evaluate(() => window.clicks), 0);

  await load('<form><button type="button" role="checkbox" aria-checked="false" aria-required="true">Accept terms</button><button type="button" aria-pressed="false">Receive newsletters</button></form>');
  await toggleBehavior();
  assert.equal((await fill({})).missing.length, 1);
  assert.equal(await page.evaluate(() => window.clicks), 0);
  assert.equal((await fill({ 'Accept terms': 'No' })).missing.length, 1, 'Required consent cannot be satisfied by No');

  // Conditional controls and a delayed state reset must be caught by the final audit.
  await load(`<form><div role="radiogroup" aria-label="${variant}">${custom('radio', 'Yes')}${custom('radio', 'No')}</div><div id="conditional"></div></form>`);
  await page.evaluate(() => {
    document.querySelector('[role=radiogroup]').onclick = event => {
      const target = event.target.closest('[role=radio]');
      document.querySelectorAll('[role=radio]').forEach(option => option.setAttribute('aria-checked', String(option === target)));
      setTimeout(() => { document.querySelector('#conditional').innerHTML = '<label for="detail">Unknown sponsorship detail *</label><input id="detail" required>'; }, 120);
    };
  });
  assert.ok((await fill()).missing.some(field => field.id === 'detail'));
  await load(`<form><div role="radiogroup" aria-label="${variant}">${custom('radio', 'Yes')}${custom('radio', 'No')}</div></form>`);
  await page.evaluate(() => {
    document.querySelector('[role=radiogroup]').onclick = event => {
      const target = event.target.closest('[role=radio]');
      document.querySelectorAll('[role=radio]').forEach(option => option.setAttribute('aria-checked', String(option === target)));
      setTimeout(() => target.setAttribute('aria-checked', 'false'), 120);
    };
  });
  assert.equal((await fill()).missing.length, 1);
  assert.equal(requests, 0);
  assert.equal(submissions, 0);
  console.log(`PASS: ${cases} choice-control fills covering grouping, hidden inputs, ARIA radios/checkboxes/switches/toggles/listboxes, multi-select sets, config, wording boundaries, ambiguity, conflicts, rejected changes, disabled/mixed states, rerenders, delayed resets, and idempotency; no network or submissions.`);
} finally { await browser.close(); }
