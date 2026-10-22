import type { Frame, Locator } from 'playwright';
import type { Profile } from './types.js';
import { annotateWorkday, fillWorkdayPrompt } from './workday-controls.js';
import { chosenOption } from './field-matching.js';
export interface WorkdayResult { filled: string[]; missing: { label: string; type: string }[] }
const groups = {
  experience: { section: '[data-automation-id="workExperienceSection"], [role="group"][aria-labelledby*="Employment-History-section"], [role="group"][aria-labelledby*="Work-Experience-section"]',
    rows: '[data-automation-id^="workExperience-"], [role="group"][aria-labelledby*="Employment-History-"][aria-labelledby$="-panel"], [role="group"][aria-labelledby*="Work-Experience-"][aria-labelledby$="-panel"]', add: /add (another )?(work experience|work history)/i },
  education: { section: '[data-automation-id="educationSection"], [role="group"][aria-labelledby="Education-section"]',
    rows: '[data-automation-id^="education-"], [role="group"][aria-labelledby^="Education-"][aria-labelledby$="-panel"]', add: /add (another )?(education|school)/i },
  languages: { section: '[data-automation-id="languageSection"], [aria-labelledby*="Languages"][aria-labelledby$="-section"]', rows: '[data-automation-id^="language-"], [aria-labelledby^="Languages-"][aria-labelledby$="-panel"]', add: /add (another )?languages?/i },
  websites: { section: '[data-automation-id="websiteSection"], [data-automation-id="websitesSection"]', rows: '[data-automation-id^="website-"], [data-automation-id^="websites-"]', add: /add (another )?website/i }
} as const;
async function markRows(frame: Frame, kind: keyof typeof groups): Promise<Locator> {
  await frame.evaluate(({ selector, kind }) => {
    document.querySelectorAll(`[data-ap-wd-row^="${kind}-"]`).forEach(el => el.removeAttribute('data-ap-wd-row'));
    const all = [...document.querySelectorAll(selector)].filter(el => !!el.getClientRects().length && el.querySelector('input,textarea,select'));
    const outer = all.filter(el => !all.some(other => other !== el && other.contains(el)));
    outer.forEach((el, i) => el.setAttribute('data-ap-wd-row', `${kind}-${i}`));
  }, { selector: groups[kind].rows, kind });
  return frame.locator(`[data-ap-wd-row^="${kind}-"]`);
}
async function ensureRows(frame: Frame, kind: keyof typeof groups, length: number, result: WorkdayResult): Promise<Locator | null> {
  let rows = await markRows(frame, kind);
  const spec = groups[kind];
  const section = frame.locator(spec.section).filter({ visible: true });
  if (!await rows.count() && !await section.count()) return null; // This step has no such section.
  if (await rows.count() > length) {
    result.missing.push({ label: `${kind}: existing rows exceed profile rows; reconcile them manually (no entries were deleted)`, type: 'workday_conflict' });
  }
  for (let tries = 0; await rows.count() < length && tries < Math.min(length, 30); tries++) {
    const before = await rows.count();
    let add = frame.getByRole('button', { name: spec.add }).filter({ visible: true });
    if (await add.count() !== 1 && await section.count() === 1) add = section.locator('button[data-automation-id="add-button"]').filter({ visible: true });
    if (await add.count() !== 1) { result.missing.push({ label: `${kind}: could not identify a unique Add control`, type: 'workday_section' }); break; }
    await add.click();
    const deadline = Date.now() + 3000;
    do { await frame.waitForTimeout(100); rows = await markRows(frame, kind); } while (await rows.count() <= before && Date.now() < deadline);
    if (await rows.count() <= before) { result.missing.push({ label: `${kind}: Add did not create another row`, type: 'workday_section' }); break; }
  }
  return rows;
}
function validDate(value: string): boolean {
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(value)) return false;
  if (/^\d{4}$/.test(value)) return Number(value) >= 1900 && Number(value) <= 2200;
  const [year, month, day = 1] = value.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return year >= 1900 && year <= 2200 && d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}
async function textOrPrompt(frame: Frame, root: Locator, selector: string, value: string | undefined, label: string, result: WorkdayResult): Promise<void> {
  if (value === undefined || value === '') return;
  const control = root.locator(selector).filter({ visible: true });
  if (await control.count() !== 1) { result.missing.push({ label: `${label}: control missing or ambiguous`, type: 'workday_field' }); return; }
  const info = await control.evaluate(el => ({ prompt: el.hasAttribute('data-ap-wd-prompt'), tag: el.tagName, value: (el as HTMLInputElement).value ?? '' }));
  const matchLabel = / degree$/.test(label) ? 'Degree' : label;
  try {
    if (info.prompt) {
      if (!await fillWorkdayPrompt(frame, control, value, matchLabel)) throw new Error('Selection was not committed');
    } else if (info.tag === 'SELECT') {
      const options = await control.locator('option').evaluateAll(els => els.filter(el => !(el as HTMLOptionElement).disabled && !el.closest('optgroup[disabled]')).map(el => (el as HTMLOptionElement).label.trim()));
      const match = chosenOption(options, value, matchLabel);
      if (!match) throw new Error('Option is ambiguous or missing');
      await control.selectOption({ label: match });
      const selected = await control.evaluate(el => (el as HTMLSelectElement).selectedOptions[0]?.label.trim());
      if (selected !== match) throw new Error('Selection was not committed');
    } else {
      if (info.value && info.value.trim() !== value.trim()) throw new Error('Existing value differs; reconcile manually');
      if (!info.value) { await control.fill(value); await control.blur(); }
      if ((await control.inputValue()).trim() !== value.trim()) throw new Error('Value did not persist');
    }
    result.filled.push(label);
  } catch (error) { result.missing.push({ label: `${label}: ${error instanceof Error ? error.message : 'fill failed'}`, type: 'workday_field' }); }
}
async function datePartsImpl(root: Locator, field: string, value: string | undefined, label: string, result: WorkdayResult): Promise<void> {
  if (!value) return;
  if (!validDate(value)) { result.missing.push({ label: `${label}: use a valid YYYY, YYYY-MM, or YYYY-MM-DD date`, type: 'workday_date' }); return; }
  let container = root.locator(`[data-automation-id="formField-${field}"], [data-automation-id="${field}"]`);
  // Nested field/date containers often both match; prefer the outermost one.
  container = container.first();
  if (!await container.count()) { result.missing.push({ label: `${label}: date control not found`, type: 'workday_date' }); return; }
  const [year, month, day] = value.split('-');
  if (await container.evaluate(el => el instanceof HTMLInputElement && !['date','month'].includes(el.type))) {
    const current = await container.inputValue();
    if (current && current !== year) result.missing.push({ label: `${label}: existing year differs`, type: 'workday_date' });
    else { await container.fill(year); await container.blur(); if (await container.inputValue() !== year) result.missing.push({ label: `${label}: year did not persist`, type: 'workday_date' }); }
    return;
  }
  const native = container.locator('input[type="date"],input[type="month"]');
  if (await native.count() === 1) {
    const type = await native.getAttribute('type');
    if (type === 'date' && !day) { result.missing.push({ label: `${label}: a full day is required; no day was inferred`, type: 'workday_date' }); return; }
    if (!month) { result.missing.push({ label: `${label}: a month is required; no month was inferred`, type: 'workday_date' }); return; }
    const expected = type === 'month' ? `${year}-${month}` : value;
    const current = await native.inputValue();
    if (current && current !== expected) { result.missing.push({ label: `${label}: existing date differs`, type: 'workday_date' }); return; }
    await native.fill(expected); await native.blur();
    if (await native.inputValue() !== expected) result.missing.push({ label: `${label}: date did not persist`, type: 'workday_date' });
    else result.filled.push(label);
    return;
  }
  for (const [part, expected] of [['Year', year], ['Month', month], ['Day', day]] as const) {
    const control = container.locator(`input[aria-label="${part}"],input[data-automation-id="dateSection${part}"]`);
    if (!await control.count() && part === 'Day') continue;
    if (!expected || await control.count() !== 1) { result.missing.push({ label: `${label}: ${part} is missing or ambiguous`, type: 'workday_date' }); continue; }
    const current = await control.inputValue();
    if (current && Number(current) !== Number(expected)) { result.missing.push({ label: `${label}: existing ${part} differs`, type: 'workday_date' }); continue; }
    await control.fill(String(Number(expected))); await control.blur();
    if (Number(await control.inputValue()) !== Number(expected)) result.missing.push({ label: `${label}: ${part} did not persist`, type: 'workday_date' });
  }
}
async function dateParts(root: Locator, field: string, value: string | undefined, label: string, result: WorkdayResult): Promise<void> {
  try { await datePartsImpl(root, field, value, label, result); }
  catch (error) { result.missing.push({ label: `${label}: ${error instanceof Error ? error.message : 'date interaction failed'}`, type: 'workday_date' }); }
}
export async function prepareWorkday(frame: Frame, profile: Profile): Promise<WorkdayResult> {
  const result: WorkdayResult = { filled: [], missing: [] };
  await annotateWorkday(frame);
  for (const kind of ['experience', 'education', 'websites', 'languages'] as const) {
    const entries = profile[kind];
    if (entries === undefined) {
      await markRows(frame, kind); // Prevent the generic filler from leaking profile values into history rows.
      const section = frame.locator(groups[kind].section).filter({ visible: true });
      if (await section.count() && await section.evaluateAll(els => els.some(el => el.getAttribute('aria-required') === 'true'))) result.missing.push({ label: `${kind}: provide structured profile data for this required section`, type: 'workday_profile' });
      continue;
    }
    if (!Array.isArray(entries) || entries.length > 30) { result.missing.push({ label: `${kind}: expected an array with at most 30 entries`, type: 'workday_profile' }); continue; }
    if (entries.some(entry => kind === 'websites' ? typeof entry !== 'string' : !entry || typeof entry !== 'object')) { result.missing.push({ label: `${kind}: invalid entry`, type: 'workday_profile' }); continue; }
    const invalidTypes = entries.some(entry => {
      if (kind === 'websites') return typeof entry !== 'string';
      return Object.entries(entry as unknown as Record<string, unknown>).some(([key, value]) => value !== undefined && (['current', 'native'].includes(key) ? typeof value !== 'boolean' : typeof value !== 'string'));
    });
    const placeholders = entries.some(entry => typeof entry === 'string' ? /YOUR_|REPLACE_WITH_/i.test(entry) : Object.values(entry).some(value => typeof value === 'string' && /^(YOUR_|REPLACE_WITH_)/i.test(value)));
    if (placeholders) { result.missing.push({ label: `${kind}: replace profile placeholders before filling`, type: 'workday_profile' }); continue; }
    if (invalidTypes) { result.missing.push({ label: `${kind}: use text fields and a boolean current flag`, type: 'workday_profile' }); continue; }
    const rows = await ensureRows(frame, kind, entries.length, result);
    if (!rows) continue;
    await annotateWorkday(frame);
    for (let i = 0; i < entries.length && i < await rows.count(); i++) {
      const row = rows.nth(i); const prefix = `${kind} ${i + 1}`;
      if (kind === 'websites') {
        const value = profile.websites![i];
        await textOrPrompt(frame, row, 'input[data-automation-id="website"],input[type="url"],input[name="url"]', value, prefix, result);
      } else if (kind === 'experience') {
        const item = profile.experience![i];
        for (const [key, selector] of Object.entries({ title: 'input[data-automation-id="jobTitle"],input[name="jobTitle"]', company: 'input[data-automation-id="company"],input[name="companyName"]', location: 'input[data-automation-id="location"],input[name="location"]', description: 'textarea[data-automation-id="description"],textarea[id*="roleDescription"]' })) {
          await textOrPrompt(frame, row, selector, item[key as keyof typeof item] as string | undefined, `${prefix} ${key}`, result);
        }
        const current = row.locator('input[data-automation-id="currentlyWorkHere"],input[name="currentlyWorkHere"]');
        if (typeof item.current === 'boolean' && await current.count() === 1) await current.setChecked(item.current);
        await dateParts(row, 'startDate', item.startDate, `${prefix} start date`, result);
        if (item.current !== true) await dateParts(row, 'endDate', item.endDate, `${prefix} end date`, result);
      } else if (kind === 'education') {
        const item = profile.education![i];
        for (const [key, selector] of Object.entries({ school: '[data-automation-id="school"]:is(input,button),input[name="schoolName"],[data-automation-id="formField-school"] input', degree: '[data-automation-id="degree"]:is(input,button,select),[data-automation-id="formField-degree"] :is(input,button,select)', fieldOfStudy: '[data-automation-id="fieldOfStudy"]:is(input,button,select),input[name="fieldOfStudy"],[data-automation-id="formField-fieldOfStudy"] :is(input,button,select)', gpa: 'input[data-automation-id="gpa"]' })) {
          await textOrPrompt(frame, row, selector, item[key as keyof typeof item], `${prefix} ${key}`, result);
        }
        await dateParts(row, 'firstYearAttended', item.startDate, `${prefix} start date`, result);
        await dateParts(row, 'lastYearAttended', item.endDate, `${prefix} end date`, result);
      } else {
        const item = profile.languages![i];
        await textOrPrompt(frame, row, '[data-automation-id="formField-language"] button', item.name, `${prefix} name`, result);
        const native = row.locator('input[name="native"], [data-automation-id*="nativeLanguage"] input[type="checkbox"]');
        if (typeof item.native === 'boolean') {
          if (await native.count() === 1) await native.setChecked(item.native);
          else result.missing.push({ label: `${prefix}: native-language control missing or ambiguous`, type: 'workday_field' });
        }
        for (const key of ['reading', 'writing', 'speaking', 'listening', 'overall', 'level'] as const) {
          const names = { reading: 'Read', writing: 'Writ', speaking: 'Speak', listening: 'Listen', overall: 'Overall', level: 'Level' };
          await textOrPrompt(frame, row, `button[aria-label*="${names[key]}"]`, item[key], `${prefix} ${key}`, result);
        }
      }
    }
  }
  if (profile.skills !== undefined) {
    if (!Array.isArray(profile.skills) || profile.skills.length > 100 || profile.skills.some(skill => typeof skill !== 'string' || /YOUR_|REPLACE_WITH_/i.test(skill))) result.missing.push({ label: 'skills: supply at most 100 verified skill names', type: 'workday_profile' });
    else {
      const section = frame.locator('[data-automation-id="skillsSection"], [data-automation-id="formField-skills"]').filter({ visible: true });
      const input = section.locator('input').filter({ visible: true });
      if (await section.count() && profile.skills.length && await input.count() !== 1) result.missing.push({ label: 'Skills search is missing or ambiguous', type: 'workday_field' });
      else if (await input.count() === 1) for (const skill of profile.skills) {
        if (await fillWorkdayPrompt(frame, input, skill)) result.filled.push(`Skill: ${skill}`);
        else result.missing.push({ label: `Skill selection not committed: ${skill}`, type: 'workday_field' });
      }
    }
  }
  return result;
}
export async function workdayValidation(frame: Frame): Promise<WorkdayResult['missing']> {
  const missing: WorkdayResult['missing'] = [];
  const uploads = frame.locator('[data-automation-id="resumeUpload"], [data-automation-id="quickApplyUpload"]');
  const busy = uploads.locator('[role="progressbar"], [data-automation-id="file-upload-progress"]');
  const deadline = Date.now() + 15000;
  while (await busy.filter({ visible: true }).count() && Date.now() < deadline) await frame.waitForTimeout(200);
  if (await busy.filter({ visible: true }).count()) missing.push({ label: 'Resume upload is still processing', type: 'workday_upload' });
  const errors = await frame.locator('[data-automation-id="errorMessage"], [data-automation-id="file-upload-error"], [data-automation-id="errorSummary"]')
    .filter({ visible: true }).allTextContents();
  for (const text of new Set(errors.map(s => s.trim()).filter(Boolean))) missing.push({ label: text, type: 'workday_validation' });
  return missing;
}
