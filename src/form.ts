import { prepareWorkday, workdayValidation } from './workday.js';
import { annotateWorkday, fillWorkdayPrompt, workdayCommitted } from './workday-controls.js';
import { submissionMessages } from './confirmation.js';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Page } from 'playwright';
import type { ApplicationScope } from './form-detection.js';
import type { AnswerBank, Field, Profile, ATS } from './types.js';
import { educationRecords } from './education-values.js';
import { applicationCountry } from './job-context.js';
import { normalize, resolveApprovedAnswer } from './answers.js';
import { chosenOption, resolveOption } from './field-matching.js';
import { optionSearchTerms } from './degree-matching.js';
import type { LocalAnswerResolver } from './local-resolver.js';
import { fieldAnswer } from './profile-values.js';
import { inspectFields as inspect } from './field-inspection.js';
import { applyChoice, choiceHasValue, choiceMatches } from './choice-controls.js';
import { waitForFormStability } from './form-stability.js';
import { phoneMatches } from './contact-matching.js';
import { fillLeverLocation, leverLocationCommitted } from './lever-controls.js';
import { annotateFields, adapterControl, adapterFor } from './simplify.js';

async function resumeWidgetState(page: ApplicationScope, metadata: { selector: string; rootIndex: number; inputId: string; requireFilename: boolean }, filename: string) {
  return page.evaluate(({ selector, rootIndex, filename, inputId, requireFilename }) => {
    const root = document.querySelectorAll(selector)[rootIndex];
    if (!root) return { accepted: false, failed: false };
    // Widget positions can change after a rerender; preserve field association.
    if (selector === '.file-upload') {
      const field = root.closest('.field-wrapper') ?? root;
      if (![...field.querySelectorAll('label')].some(label =>
        (inputId && label.getAttribute('for') === inputId) || /resume|curriculum|\bcv\b/i.test(label.textContent ?? ''))) {
        return { accepted: false, failed: false };
      }
    }
    const visible = (el: Element) => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const failed = [...root.querySelectorAll('[data-automation-id="file-upload-error"], [role="alert"], .file-upload__error')].some(visible);
    const busy = [...root.querySelectorAll('[role="progressbar"], [data-automation-id="file-upload-progress"], [aria-busy="true"]')].some(visible);
    const succeeded = [...root.querySelectorAll('[data-automation-id="file-upload-successful"], [data-automation-id="file-upload-item"]')].some(visible);
    const visibleName = [...root.querySelectorAll('*')].some(node => !node.childElementCount && visible(node) && node.textContent?.trim() === filename);
    // A success marker that existed before this upload cannot prove acceptance
    // of a replacement file until the widget displays the requested filename.
    const accepted = !failed && !busy && (visibleName || (succeeded && !requireFilename));
    root.querySelectorAll('input[type="file"]').forEach(el => {
      if (accepted) el.setAttribute('data-ap-wd-file-accepted', 'true');
      else el.removeAttribute('data-ap-wd-file-accepted');
    });
    return { accepted, failed };
  }, { ...metadata, filename }).catch(() => ({ accepted: false, failed: false }));
}

async function uploadResume(page: ApplicationScope, resumePath: string): Promise<{ found: boolean; confirmed: boolean; recheck?: () => Promise<boolean> }> {
  const prefix = await page.locator('[data-ap-scope]').count() ? '[data-ap-scope] ' : '';
  const fileInputs = page.locator(prefix + 'input[type="file"]');
  const count = await fileInputs.count();
  if (!count) return { found: false, confirmed: false };
  const filePath = path.resolve(resumePath);
  if (!existsSync(filePath)) throw new Error(`Resume missing: ${filePath}`);
  for (let i = 0; i < count; i++) {
    const item = fileInputs.nth(i);
    const metadata = await item.evaluate((el, filename) => {
      const inp = el as HTMLInputElement;
      let selector = el.closest('[data-automation-id="resumeUpload"]') ? '[data-automation-id="resumeUpload"]'
        : el.closest('[data-automation-id="quickApplyUpload"]') ? '[data-automation-id="quickApplyUpload"]'
        : el.closest('.file-upload') ? '.file-upload' : '';
      let root = selector ? el.closest(selector) : null;
      const genericRoot = el.parentElement?.parentElement;
      if (!root && genericRoot?.querySelector('[role="progressbar"], [data-automation-id*="upload"]')) {
        genericRoot.setAttribute('data-ap-upload-root', 'resume');
        selector = '[data-ap-upload-root="resume"]';
        root = genericRoot;
      }
      const visible = (node: Element) => !!node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
      const visibleName = root && [...root.querySelectorAll('*')].some(node =>
        !node.childElementCount && visible(node) && node.textContent?.trim() === filename);
      const alreadyAccepted = !!visibleName && !!root?.querySelector('[data-automation-id="file-upload-successful"], [data-automation-id="file-upload-item"]') &&
        !root.querySelector('[data-automation-id="file-upload-error"], [role="progressbar"], [aria-busy="true"]');
      el.removeAttribute('data-ap-wd-file-accepted');
      if (alreadyAccepted) el.setAttribute('data-ap-wd-file-accepted', 'true');
      return { key: el.getAttribute('data-ap-key'), text: `${inp.name} ${inp.id} ${inp.labels?.[0]?.textContent ?? ''}`.toLowerCase(),
        inputId: inp.id, selector, rootIndex: root ? [...document.querySelectorAll(selector)].indexOf(root) : -1,
        alreadyAccepted, requireFilename: !!root?.querySelector('[data-automation-id="file-upload-successful"], [data-automation-id="file-upload-item"]') };
    }, path.basename(filePath));
    if (metadata.key === 'coverLetter') continue;
    if (!(metadata.key === 'resume' || /resume|cv|curriculum/.test(metadata.text) || (count === 1 && !/cover|photo|portfolio/.test(metadata.text)))) continue;
    const filename = path.basename(filePath);
    const recheck = metadata.selector
      ? async () => (await resumeWidgetState(page, metadata, filename)).accepted
      : async () => item.evaluateAll((elements, expected) => {
        const input = elements[0] as HTMLInputElement | undefined;
        const accepted = !!input && input.id === expected.id && input.files?.[0]?.name === expected.filename;
        if (input && !accepted) input.removeAttribute('data-ap-wd-file-accepted');
        return accepted;
      }, { id: metadata.inputId, filename }).catch(() => false);
    if (metadata.alreadyAccepted) return { found: true, confirmed: true, recheck };
    // Keep a handle to the original node; the scoped locator can disappear when
    // Greenhouse replaces the input/form after an upload. Detached native inputs
    // are not evidence that the server accepted an attachment.
    const input = await item.elementHandle().catch(() => null);
    try {
      await item.setInputFiles(filePath);
      const deadline = Date.now() + (metadata.selector ? 15000 : 500);
      do {
        if (metadata.selector) {
          const state = await resumeWidgetState(page, metadata, filename);
          if (state.accepted || state.failed) return { found: true, confirmed: state.accepted, recheck };
        } else {
          const attached = await input?.evaluate((el, expected) => {
            const accepted = el.isConnected && (el as HTMLInputElement).files?.[0]?.name === expected;
            if (accepted) el.setAttribute('data-ap-wd-file-accepted', 'true');
            return accepted;
          }, filename).catch(() => false);
          if (attached) return { found: true, confirmed: true, recheck };
        }
        await page.waitForTimeout(200);
      } while (Date.now() < deadline);
      return { found: true, confirmed: false };
    } catch {
      // An unconfirmed upload must not prevent filling unrelated factual fields.
      return { found: true, confirmed: false };
    } finally { await input?.dispose(); }
  }
  return { found: false, confirmed: false };
}

// Greenhouse and similar ATSs use React/ARIA comboboxes, not native <select>s.
// We only click user-visible options, never mutate React state or hidden inputs.
async function comboboxCommitted(page: ApplicationScope, field: Field): Promise<boolean> {
  if (field.leverLocation) return leverLocationCommitted(page, field);
  return page.locator(`[data-ja-field="${field.key}"]`).first().evaluate((el, label) => {
    const input = el as HTMLInputElement;
    // Empty React input after selection is normal; the selected text is typically
    // rendered into .select__single-value inside the widget's control.
    const value = (input.value || '').trim();
    const configured = el.getAttribute('data-ap-selected')?.trim();
    if (configured && !/^(select|choose)( an option)?\.{0,3}$/i.test(configured)) return true;
    const outer = el.closest('[class*="select__control"], [class*="react-select__control"], [class$="-control"], [data-slot="select-trigger"]');
    const chosen = outer?.querySelector('[class*="single-value"], [class*="singleValue"], [data-slot="select-value"]');
    const display = (chosen?.textContent || '').trim();
    // For location typeahead, typed text alone is NOT a committed place.
    if (/location\s*\(city\)/i.test(label)) {
      const form = el.closest('form') || document;
      const latitude = form.querySelector<HTMLInputElement>('input[name*="latitude" i], input[id*="latitude" i]');
      const longitude = form.querySelector<HTMLInputElement>('input[name*="longitude" i], input[id*="longitude" i]');
      if (latitude && longitude) return !!latitude.value.trim() && !!longitude.value.trim();
      return !!display && !/^(select|select\.\.\.|choose|choose an option)$/i.test(display);
    }
    if (el.matches('button[aria-haspopup="listbox"]') && el.getAttribute('aria-expanded') !== 'true' && el.textContent?.trim() && !/^(select|choose)/i.test(el.textContent.trim())) return true;
    if (display && !/^(select|select\.\.\.|choose|choose an option)$/i.test(display)) return true;
    // Closed query text alone is not selection evidence. For widgets that only
    // display the input value, require a verified option click from this run.
    return !!value && el.getAttribute('data-ap-committed-option') === value && input.getAttribute('aria-expanded') === 'false' &&
      !/^(select|choose)( an option)?\.{0,3}$/i.test(value);
  }, field.label).catch(() => false);
}

async function optionLocator(page: ApplicationScope, field: Field) {
  await page.locator(`[data-ja-field="${field.key}"]`).first().evaluate(el => {
    document.querySelectorAll('[data-ap-option]').forEach(item => item.removeAttribute('data-ap-option'));
    const ids = (el.getAttribute('aria-controls') || el.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean);
    const roots = ids.map(id => document.getElementById(id)).filter((item): item is HTMLElement => !!item);
    const wrapperId = el.getAttribute('data-ap-wrapper');
    const wrapper = wrapperId ? document.querySelector(`[data-ap-wrapper-root="${wrapperId}"]`) : null;
    const visible = (item: Element) => !!item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden';
    let options = roots.flatMap(root => [...root.querySelectorAll('[role="option"]')]).filter(visible);
    if (!options.length && wrapper) {
      let paths: string[] = [];
      try { paths = JSON.parse(el.getAttribute('data-ap-options') || '[]'); } catch {}
      for (const xpath of paths) {
        if (/%[A-Z_]+%|\{\{|\/shadow-root\//.test(xpath)) continue;
        try {
          const result = document.evaluate(xpath, wrapper, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
          for (let i = 0; i < result.snapshotLength; i++) {
            const item = result.snapshotItem(i);
            if (item instanceof Element && visible(item)) options.push(item);
          }
        } catch {}
        if (options.length) break;
      }
    }
    if (!options.length) {
      const menus = [...document.querySelectorAll('[role="listbox"]')].filter(visible);
      if (menus.length <= 1) options = [...document.querySelectorAll('[role="option"]')].filter(visible);
    }
    [...new Set(options)].filter(item => !item.matches('[aria-disabled="true"], [disabled]'))
      .forEach(item => item.setAttribute('data-ap-option', 'true'));
  });
  return page.locator('[data-ap-option="true"]:visible');
}

async function applyCombobox(page: ApplicationScope, f: Field, value: string, profile: Profile): Promise<boolean> {
  if (f.leverLocation) return fillLeverLocation(page, f, value, profile);
  const input = page.locator(`[data-ja-field="${f.key}"]`).first();
  try {
    await input.click({ timeout: 3500 });
    let opts = await optionLocator(page, f);
    let available = await opts.allTextContents();
    let resolution = resolveOption(available.map(x => x.trim()).filter(Boolean), value, f.label, profile);
    const editable = await input.evaluate(el =>
      el instanceof HTMLInputElement && !el.readOnly && !el.disabled).catch(() => false);
    // A search term is only a way to discover options. Resolve against the
    // original approved fact, even when searching for the broader degree level.
    for (const query of optionSearchTerms(value, f.label)) {
      if (resolution.status !== 'unmatched') break;
      if (editable) await input.fill(query, { timeout: 3500 });
      else await input.press('ArrowDown', { timeout: 2000 });
      await page.waitForTimeout(650);
      const deadline = Date.now() + 2000;
      do {
        opts = await optionLocator(page, f);
        available = await opts.allTextContents();
        resolution = resolveOption(available.map(x => x.trim()).filter(Boolean), value, f.label, profile);
        if (available.length) break;
        await page.waitForTimeout(150);
      } while (Date.now() < deadline);
      if (!editable) break;
    }
    await input.evaluate((el, options) => el.setAttribute('data-ap-known-options', JSON.stringify(options)), available.map(x => x.trim()));
    if (resolution.status !== 'matched') {
      if (editable) await input.fill('', { timeout: 2000 });
      await input.press('Escape').catch(() => {});
      return false;
    }
    const match = resolution.option;
    const indices = available.map((text, i) => text.trim() === match ? i : -1).filter(i => i >= 0);
    if (indices.length !== 1) return false;
    const target = opts.nth(indices[0]);
    await target.click({ timeout: 3500 });
    await page.waitForTimeout(200);
    // The selected value must be visible/committed, not merely typed.
    // React re-rendering can replace the old element; identify by stable id/name.
    const candidates = f.id ? page.locator(`[id="${f.id.replace(/"/g, '\\"')}"]`) :
      f.name ? page.locator(`[name="${f.name.replace(/"/g, '\\"')}"]`) : input;
    await candidates.first().evaluate((el, options) => el.setAttribute('data-ap-known-options', JSON.stringify(options)), available.map(x => x.trim()));
    const committed = await candidates.first().evaluate((el, selected) => {
      if (el.getAttribute('aria-invalid') === 'true') return false;
      const field = el as HTMLInputElement;
      const control = el.closest('[class*="select__control"], [class*="react-select__control"], [class$="-control"], [data-slot="select-trigger"]');
      const single = control?.querySelector('[class*="single-value"], [class*="singleValue"], [data-slot="select-value"]');
      return (single?.textContent || '').trim() === selected ||
        (el.getAttribute('data-ap-selected') || '').trim() === selected ||
        (el.matches('button[aria-haspopup="listbox"]') && (el.textContent || '').trim() === selected) ||
        ((field.value || '').trim() === selected && el.getAttribute('aria-expanded') === 'false');
    }, match).catch(() => false);
    // Some newer widgets store location selections in hidden latitude/longitude
    // rather than displaying the full selected option in the input.
    if (!committed && /location\s*\(city\)/i.test(f.label)) {
      return await page.evaluate(() => {
        const lat = document.querySelector<HTMLInputElement>('input[name*="latitude" i], input[id*="latitude" i]');
        const lng = document.querySelector<HTMLInputElement>('input[name*="longitude" i], input[id*="longitude" i]');
        return !!lat?.value.trim() && !!lng?.value.trim();
      }).catch(() => false);
    }
    if (committed) await candidates.first().evaluate((el, selected) => el.setAttribute('data-ap-committed-option', selected), match);
    return committed;
  } catch {
    return false;
  }
}

async function valueExists(page: ApplicationScope, f: Field, resumeUploaded: boolean): Promise<boolean> {
  if (f.kind === 'file' && resumeUploaded && (f.semanticKey === 'resume' || /resume|cv/i.test(f.label))) {
    const accepted = await page.locator(`[data-ja-field="${f.key}"]`).first().getAttribute('data-ap-wd-file-accepted');
    if (accepted === 'true') return true;
  }
  if (f.workdayPrompt) return workdayCommitted(page.locator(`[data-ja-field="${f.key}"]`).first());
  if (f.kind === 'combobox') return comboboxCommitted(page, f);
  if (f.choice) return choiceHasValue(page, f);
  const selector = `[data-ja-field="${f.key}"]`;
  return page.locator(selector).first().evaluate(el => {
    const input = el as HTMLInputElement;
    if (input.type === 'file') return el.hasAttribute('data-ap-wd-file-accepted');
    if (input.isContentEditable) return !!input.textContent?.trim();
    const value = (input.value || '').trim();
    return !!value;
  }).catch(() => false);
}

async function valueMatchesAnswer(page: ApplicationScope, f: Field, expected: string, profile: Profile, resumeUploaded: boolean): Promise<boolean> {
  if (f.kind === 'file') return valueExists(page, f, resumeUploaded);
  if (f.workdayPrompt) return workdayCommitted(page.locator(`[data-ja-field="${f.key}"]`).first(), expected.split(/\s+>\s+/).at(-1), expected.includes(' > ') ? '' : f.label);
  if (f.kind === 'combobox') {
    const actual = await page.locator(`[data-ja-field="${f.key}"]`).first().evaluate(el => {
      const control = el.closest('[class*="select__control"], [class*="react-select__control"], [class$="-control"], [data-slot="select-trigger"]');
      const selected = control?.querySelector('[class*="single-value"], [class*="singleValue"], [data-slot="select-value"]');
      return (selected?.textContent || el.getAttribute('data-ap-selected') || (el as HTMLInputElement).value || el.textContent || '').trim();
    }).catch(() => '');
    if (!await comboboxCommitted(page, f)) return false;
    const option = chosenOption(f.options?.length ? f.options : [actual], expected, f.label, profile);
    return !!option && normalize(actual) === normalize(option);
  }
  if (f.choice) return choiceMatches(page, f, expected, profile);
  const actual = await page.locator(`[data-ja-field="${f.key}"]`).first().evaluate(el => (el as HTMLInputElement).isContentEditable ? el.textContent?.trim() || '' : (el as HTMLInputElement).value?.trim() || '').catch(() => '');
  if (f.kind === 'tel') return normalize(actual) === normalize(expected) || phoneMatches(actual, expected);
  return normalize(actual) === normalize(expected);
}

async function applyAnswer(page: ApplicationScope, f: Field, value: string, profile: Profile): Promise<boolean> {
  const locator = page.locator(`[data-ja-field="${f.key}"]`).first();
  try {
    if (f.workdayPrompt) return await fillWorkdayPrompt(page, locator, value, f.label);
    if (['text', 'email', 'tel', 'url', 'number', 'textarea', 'search', 'date', 'contenteditable'].includes(f.kind)) {
      await locator.fill(value, { timeout: 2000 });
      await locator.blur();
      return await locator.evaluate((el, expected) => (el as HTMLInputElement).isContentEditable ? el.textContent?.trim() === expected : (el as HTMLInputElement).value === expected, value);
    }
    if (f.kind === 'combobox') return await applyCombobox(page, f, value, profile);
    if (f.choice) return await applyChoice(page, f, value, profile);
    return false;
  } catch {
    return false;
  }
}

export async function revealApplication(page: Page, ats?: ATS | null): Promise<void> {
  const configured = await adapterControl(page.mainFrame(), ats, 'apply');
  if (configured) { await configured.click({ timeout: 4000 }); await page.waitForTimeout(400); return; }
  const forms = page.locator('form');
  const hasInputs = (await page.locator('input[type="email"], input[name*="email" i]').count()) > 0;
  if (await forms.count() && hasInputs) return;
  const button = page.getByRole('button', { name: /^(apply|apply now|apply for this job|apply to this job)$/i }).first();
  const link = page.getByRole('link', { name: /^(apply|apply now|apply for this job|apply to this job)$/i }).first();
  if (await button.count() && await button.isVisible()) await button.click({ timeout: 4000 });
  else if (await link.count() && await link.isVisible()) await link.click({ timeout: 4000 });
  await page.waitForTimeout(400);
}

export async function fillApplication(page: ApplicationScope, profile: Profile, bank: AnswerBank, ats?: ATS | null, resolver?: LocalAnswerResolver): Promise<{
  filled: string[];
  missing: { label: string; type: string; options?: string[]; name?: string; id?: string; placeholder?: string; context?: string }[];
  resumeUploaded: boolean;
}> {
  // Greenhouse exposes repeatable education rows with stable indexed IDs.
  if (ats?.toLowerCase() === 'greenhouse') {
    const records = educationRecords(profile, bank);
    const section = page.locator('.education--container');
    if (await section.count() === 1) {
      for (let i = 0; i < records.length; i++) {
        if (await section.locator(`[id="school--${i}"]`).count()) continue;
        const add = section.getByRole('button', { name: 'Add another', exact: true });
        if (await add.count() !== 1 || !await add.isVisible() || !await add.isEnabled()) break;
        await add.click();
        try { await section.locator(`[id="school--${i}"]`).waitFor({ state: 'visible', timeout: 1500 }); }
        catch { break; }
      }
    }
  }
  const jobCountry = await applicationCountry(page);
  const inspectFields = async () => (await inspect(page)).map(field => ({ ...field, jobCountry }));
  await annotateFields(page, ats);
  if (adapterFor(ats)?.scopeSelector && !await page.locator('[data-ap-scope]').count()) throw new Error('Application dialog or form is not open');
  const workday = ats === 'Workday' ? await prepareWorkday(page, profile) : { filled: [], missing: [] };
  const resumeUpload = await uploadResume(page, profile.resumePath);
  let resumeUploaded = resumeUpload.confirmed;
  await annotateFields(page, ats);
  if (profile.coverLetterPath) {
    const cover = path.resolve(profile.coverLetterPath);
    if (!existsSync(cover)) throw new Error(`Cover letter missing: ${cover}`);
    const inputs = page.locator('input[type="file"][data-ap-key="coverLetter"]');
    if (await inputs.count() === 1) await inputs.setInputFiles(cover);
  }
  const filled: string[] = [...workday.filled];
  const attempted = new Map<string, number>();
  const resolved = new Map<string, string>();
  const verified = new Set<string>();
  let auditing = false;
  let settled = false;
  let recoveryIssue: string | undefined;
  const identity = (f: Field) => `${f.kind}:${f.label}:${f.name ?? ''}:${f.id ?? ''}:${f.instanceKey ?? ''}`;
  const answerFor = async (f: Field) => {
    // Never turn a deterministic conflict into an LLM decision.
    if (resolveApprovedAnswer(f.label, bank).status === 'conflict') return undefined;
    const direct = fieldAnswer(f, profile, bank);
    if (direct !== undefined) return direct;
    return resolver?.resolve(f);
  };
  // Re-inspect after each fill, because React/ATS forms may rerender controls.
  for (let i = 0; i < 90; i++) {
    await annotateFields(page, ats);
    if (ats === 'Workday') await annotateWorkday(page);
    const fields = await inspectFields();
    let next: Field | undefined, value: string | undefined;
    for (const field of fields) {
      if (field.workdayManaged || field.kind === 'file' || verified.has(identity(field)) || (attempted.get(identity(field)) ?? 0) >= (field.choice?.mode === 'multiple' ? 2 * (field.options?.length ?? 1) + 2 : 2)) continue;
      const answer = await answerFor(field);
      if (answer === undefined) continue;
      resolved.set(identity(field), answer);
      if (await valueMatchesAnswer(page, field, answer, profile, resumeUploaded)) { verified.add(identity(field)); continue; }
      next = field; value = answer; break;
    }
    if (!next || value === undefined) {
      // Allow delayed conditional controls and property-only resets to settle,
      // then audit every field again. Any subsequent fill requires another
      // quiet window and full audit; a single audit cannot cover cascading resets.
      if (!auditing) {
        if (!await waitForFormStability(page)) {
          recoveryIssue = 'Application fields kept changing; review the form before continuing';
          break;
        }
        verified.clear(); auditing = true; continue;
      }
      settled = true;
      break;
    }
    const key = identity(next);
    attempted.set(key, (attempted.get(key) ?? 0) + 1);
    await applyAnswer(page, next, value, profile);
    auditing = false;
    // Every interaction is followed by rediscovery and readback. Counters alone
    // do not establish success; final validation below decides the outcome.
    await page.waitForTimeout(80);
  }
  if (resumeUploaded && resumeUpload.recheck) resumeUploaded = await resumeUpload.recheck();
  if (resumeUploaded) filled.push('Resume');
  const uploadErrors = ats === 'Workday' ? await workdayValidation(page) : [];
  await annotateFields(page, ats);
  if (ats === 'Workday') await annotateWorkday(page);
  const finalFields = await inspectFields();
  const missing: { label: string; type: string; options?: string[]; name?: string; id?: string; placeholder?: string; context?: string }[] = [...workday.missing, ...uploadErrors];
  if (!settled) missing.push({ label: recoveryIssue ?? 'Form recovery limit reached before a stable verification pass; review before continuing', type: 'recovery' });
  for (const f of finalFields) {
    const expected = f.workdayManaged ? undefined : fieldAnswer(f, profile, bank) ?? resolved.get(identity(f));
    const conflict = !f.workdayManaged && resolveApprovedAnswer(f.label, bank).status === 'conflict';
    if (!f.required && expected === undefined && !conflict) continue;
    const matches = expected !== undefined && await valueMatchesAnswer(page, f, expected, profile, resumeUploaded);
    if (!conflict && (f.choice && f.choice.mode !== 'single' && !f.required ? matches : await valueExists(page, f, resumeUploaded)) &&
      (matches || (expected === undefined && (f.workdayManaged || f.kind === 'file')))) {
      if (attempted.has(identity(f)) && matches) filled.push(f.label || f.semanticKey || f.name || 'Field');
      continue;
    }
    missing.push({ label: f.label || '(unlabeled required field)', type: f.kind, options: f.options,
      id: f.id, name: f.name, placeholder: f.placeholder, context: f.context });
  }
  // Later steps may contain no upload control. Track uploads exposed earlier in this step even if their input was replaced.
  const resumeInputs = finalFields.filter(f => f.kind === 'file' && (f.semanticKey === 'resume' || /resume|cv|curriculum/i.test(f.label)));
  if (!resumeUploaded && (resumeUpload.found || resumeInputs.length) && !missing.some(f => f.type === 'file')) missing.push({ label: 'Resume upload could not be confirmed', type: 'file' });
  // Native and ARIA validation can reject a nonempty value. Surface those errors.
  const invalidSelector = '[aria-invalid="true"], input:invalid, select:invalid, textarea:invalid';
  const invalidRoot = await page.locator('[data-ap-scope]').count() ? page.locator('[data-ap-scope]') : page.locator('html');
  const invalid = await invalidRoot.locator(invalidSelector).evaluateAll(elements => elements
    .filter(el => el.getClientRects().length && !el.hasAttribute('data-ap-wd-file-accepted'))
    .map(el => ({ key: el.getAttribute('data-ja-choice') || el.getAttribute('data-ja-field'), label: el.getAttribute('data-ap-label') || el.getAttribute('aria-label') || (el as HTMLInputElement).labels?.[0]?.textContent?.trim() || el.id || 'Invalid field', type: 'validation' })));
  for (const field of invalid) {
    const owner = finalFields.find(item => item.key === field.key);
    const label = owner?.label || field.label;
    if (!missing.some(item => item.label === label)) missing.push({ label, type: 'validation', name: owner?.name, id: owner?.id });
  }
  return { filled, missing, resumeUploaded };
}

export async function submitAndVerify(page: ApplicationScope, ats?: ATS | null, onClick?: () => void): Promise<boolean> {
  const root = await page.locator('[data-ap-scope]').count() ? page.locator('[data-ap-scope]') : page.locator('html');
  const configured = await adapterControl(page, ats, 'submit');
  const candidates = root.getByRole('button', { name: /^(submit application|submit your application|submit|send application)$/i });
  let submit = configured;
  if (!submit) {
    const visible = candidates.filter({ visible: true });
    if (await visible.count() === 1) submit = visible;
  }
  if (!submit) throw new Error('No unambiguous final submit control; review the application manually');
  const before = new Set(await submissionMessages(page));
  await submit.click({ timeout: 7000 });
  onClick?.();
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const messages = await submissionMessages(page).catch(() => []);
    if (messages.some(message => !before.has(message))) return true;
    await page.waitForTimeout(300);
  }
  return false;
}
