import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fillApplication } from '../dist/form.js';
import { fillWorkdayPrompt, annotateWorkday } from '../dist/workday-controls.js';
import { fillJourney } from '../dist/journey.js';
const profile = { firstName: 'Alex', lastName: 'Example', fullName: 'Alex Example', email: 'alex@example.com', phone: '5555550100', resumePath: import.meta.filename,
  experience: [{ title: 'Engineer', company: 'Example One', startDate: '2022-03', endDate: '2024-08', current: false, description: 'Approved work description.' }, { title: 'Senior Engineer', company: 'Example Two', startDate: '2024-09', current: true }],
  education: [{ school: 'Example University', degree: 'Bachelor of Science', fieldOfStudy: 'Computer Science', startDate: '2018-08', endDate: '2022-05' }],
  websites: ['https://example.com'] };
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.setContent('<main><div data-automation-id="workExperienceSection"><h2>Work Experience</h2><button data-automation-id="add-button" aria-label="Add Work Experience">Add</button></div><div data-automation-id="educationSection"><h2>Education</h2><button data-automation-id="add-button" aria-label="Add Education">Add</button></div><div data-automation-id="websiteSection"><h2>Websites</h2><button data-automation-id="add-button" aria-label="Add Website">Add</button></div><button data-automation-id="bottom-navigation-next-button">Submit</button></main>');
  await page.evaluate(() => {
    const date = key => `<div data-automation-id="formField-${key}"><input aria-label="Month" required><input aria-label="Year" required></div>`;
    const field = key => `<div data-automation-id="formField-${key}"><label>${key}</label><input data-automation-id="${key}" required></div>`;
    document.querySelectorAll('button[data-automation-id="add-button"]').forEach(button => button.addEventListener('click', () => {
      const parent = button.parentElement;
      const group = parent.getAttribute('data-automation-id');
      const row = document.createElement('div');
      if (group === 'workExperienceSection') {
        row.setAttribute('data-automation-id', `workExperience-${parent.querySelectorAll('[data-automation-id^="workExperience-"]').length + 1}`);
        row.innerHTML = `${field('jobTitle')}${field('company')}<input type="checkbox" data-automation-id="currentlyWorkHere"><textarea data-automation-id="description"></textarea>${date('startDate')}${date('endDate')}`;
        row.querySelector('[type=checkbox]').addEventListener('change', event => { row.querySelector('[data-automation-id="formField-endDate"]').hidden = event.target.checked; });
      } else if (group === 'educationSection') {
        row.setAttribute('data-automation-id', 'education-1');
        row.innerHTML = `${field('school')}${field('degree')}${field('fieldOfStudy')}<input data-automation-id="firstYearAttended" required><input data-automation-id="lastYearAttended" required>`;
      } else {
        row.setAttribute('data-automation-id', 'website-1'); row.innerHTML = '<input type="url" data-automation-id="website" required>';
      }
      parent.insertBefore(row, button);
    }));
  });
  let result = await fillApplication(page.mainFrame(), profile, {}, 'Workday');
  assert.deepEqual(result.missing, []);
  assert.equal(await page.locator('[data-automation-id^="workExperience-"]').count(), 2);
  assert.deepEqual(await page.locator('input[data-automation-id="company"]').evaluateAll(els => els.map(el => el.value)), ['Example One', 'Example Two']);
  assert.equal(await page.locator('[data-automation-id="education-1"] [data-automation-id="firstYearAttended"]').inputValue(), '2018');
  assert.equal(await page.locator('[data-automation-id="workExperience-2"] [data-automation-id="currentlyWorkHere"]').isChecked(), true);
  result = await fillApplication(page.mainFrame(), profile, {}, 'Workday');
  assert.deepEqual(result.missing, []);
  assert.equal(await page.locator('[data-automation-id^="workExperience-"]').count(), 2, 'Rerun must not duplicate rows');
  await page.locator('input[data-automation-id="company"]').first().fill('A different company');
  result = await fillApplication(page.mainFrame(), profile, {}, 'Workday');
  assert.ok(result.missing.some(field => field.type === 'workday_field' && /Existing value differs/.test(field.label)));
  assert.equal(await page.locator('input[data-automation-id="company"]').first().inputValue(), 'A different company');
  // Searchable hierarchical prompt with genuine committed tokens; typing is not selection.
  await page.setContent('<div data-automation-id="formField-school"><label>School *</label><div data-automation-id="multiSelectContainer"><input id="school" role="combobox" data-automation-id="school"></div></div><div id="menu" data-automation-activepopup="true" hidden><input placeholder="Search"><div data-automation-id="promptOption">Universities</div></div>');
  await page.evaluate(() => {
    const input = document.querySelector('#school'); const menu = document.querySelector('#menu');
    input.addEventListener('click', () => { menu.hidden = false; });
    menu.querySelector('[data-automation-id="promptOption"]').addEventListener('click', () => {
      menu.innerHTML = '<div data-automation-id="promptLeafNode">Example University</div>';
      menu.firstElementChild.addEventListener('click', () => {
        const token = document.createElement('div'); token.setAttribute('data-automation-id','selectedItem'); token.textContent = 'Example University';
        input.parentElement.appendChild(token); input.value = ''; menu.hidden = true;
      });
    });
  });
  await annotateWorkday(page.mainFrame());
  assert.equal(await fillWorkdayPrompt(page.mainFrame(), page.locator('#school'), 'Universities > Example University'), true);
  // Skills are committed as tokens, and language rows use independent controls.
  await page.setContent('<main><div data-automation-id="skillsSection"><div data-automation-id="multiSelectContainer"><input id="skills" role="combobox"></div></div><div data-automation-id="languageSection"><button aria-label="Add Languages" data-automation-id="add-button">Add</button></div><div id="prompt" role="listbox" hidden></div><button data-automation-id="bottom-navigation-next-button">Submit</button></main>');
  await page.evaluate(() => {
    const popup = document.querySelector('#prompt');
    const attach = (control, values) => control.addEventListener('click', () => {
      popup.hidden = false; popup.innerHTML = '';
      for (const text of values) {
        const option = document.createElement('div'); option.setAttribute('data-automation-id','promptLeafNode'); option.textContent = text;
        option.addEventListener('click', () => {
          if (control.tagName === 'BUTTON') control.textContent = text;
          else { const token = document.createElement('div'); token.setAttribute('data-automation-id','selectedItem'); token.textContent = text; control.parentElement.appendChild(token); control.value = ''; }
          popup.hidden = true;
        });
        popup.appendChild(option);
      }
    });
    attach(document.querySelector('#skills'), ['TypeScript', 'PostgreSQL']);
    document.querySelector('[data-automation-id="add-button"]').addEventListener('click', event => {
      const row = document.createElement('div'); row.setAttribute('data-automation-id','language-1');
      row.innerHTML = '<div data-automation-id="formField-language"><label>Language *</label><button aria-haspopup="true">Select One</button></div><input type="checkbox" name="native"><div data-automation-id="formField-speaking"><label>Speaking *</label><button aria-label="Speaking" aria-haspopup="true">Select One</button></div>';
      event.target.parentElement.insertBefore(row, event.target);
      attach(row.querySelector('[data-automation-id="formField-language"] button'), ['English', 'French']);
      attach(row.querySelector('[aria-label="Speaking"]'), ['Advanced', 'Intermediate']);
    });
  });
  result = await fillApplication(page.mainFrame(), { ...profile, skills: ['TypeScript', 'PostgreSQL'], languages: [{ name: 'English', native: true, speaking: 'Advanced' }] }, {}, 'Workday');
  assert.deepEqual(result.missing, []);
  assert.deepEqual(await page.locator('[data-automation-id="selectedItem"]').allTextContents(), ['TypeScript', 'PostgreSQL']);
  assert.equal(await page.locator('[data-automation-id="language-1"] input[name="native"]').isChecked(), true);
  assert.equal(await page.locator('[aria-label="Speaking"]').innerText(), 'Advanced');
  // A completed Workday upload can clear the native input after creating its file tile.
  await page.setContent('<main><div data-automation-id="resumeUpload"><label for="resume">Resume *</label><input id="resume" type="file" name="resume" required></div><button data-automation-id="bottom-navigation-next-button">Submit</button></main>');
  await page.locator('#resume').evaluate(el => el.addEventListener('change', () => {
    const root = el.parentElement;
    const filename = el.files[0].name;
    const busy = document.createElement('div'); busy.setAttribute('role','progressbar'); root.appendChild(busy);
    setTimeout(() => { busy.remove(); el.value = ''; const tile = document.createElement('div'); tile.setAttribute('data-automation-id','file-upload-successful'); tile.textContent = filename; root.appendChild(tile); }, 900);
  }));
  result = await fillApplication(page.mainFrame(), profile, {}, 'Workday');
  assert.deepEqual(result.missing, []);
  result = await fillApplication(page.mainFrame(), profile, {}, 'Workday');
  assert.deepEqual(result.missing, []);
  assert.equal(await page.locator('[data-automation-id="file-upload-successful"]').count(), 1);
  // Server-reported Workday validation blocks even when ordinary fields have values.
  await page.setContent('<main><label>Email</label><input data-automation-id="email" value="alex@example.com"><div data-automation-id="errorMessage">Please correct your application answers</div><button data-automation-id="bottom-navigation-next-button">Submit</button></main>');
  result = await fillApplication(page.mainFrame(), profile, {}, 'Workday');
  assert.ok(result.missing.some(field => field.type === 'workday_validation'));
  // Review contains no inputs. It must remain the final step, without clicking Submit.
  await page.setContent('<div data-automation-id="applyFlowReviewPage"><h2>Review</h2><button data-automation-id="bottom-navigation-next-button" onclick="window.submitted=true">Submit</button></div>');
  const review = await fillJourney(page, page.mainFrame(), profile, {}, 'Workday', true, 5);
  assert.deepEqual(review.missing, []);
  assert.equal(await page.evaluate(() => window.submitted || false), false);
  console.log('PASS: Workday repeated history, dates, current job, education, websites, idempotence, conflicts, hierarchical prompts, skills, languages, validation, and review.');
} finally { await browser.close(); }
