import type { ApplicationScope } from './form-detection.js';
import type { Field, Profile } from './types.js';
import { resolveOption } from './field-matching.js';
import { binaryAnswer } from './answers.js';

/** Only explicit booleans; never infer consent from the existence of a checkbox. */
export function booleanAnswer(value: string): boolean | undefined {
  const binary = binaryAnswer(value)?.toLowerCase();
  if (binary) return binary === 'yes';
  if (/^true$/i.test(value.trim())) return true;
  if (/^false$/i.test(value.trim())) return false;
  return undefined;
}

export function choiceTargets(field: Field, answer: string, profile: Profile): number[] | undefined {
  if (field.choice?.mode === 'boolean') {
    const value = booleanAnswer(answer);
    return value === undefined ? undefined : value ? [0] : [];
  }
  const options = field.options ?? [];
  let answers = [answer];
  // Multi-answer strings use explicit JSON, never delimiter splitting (labels can contain commas).
  if (field.choice?.mode === 'multiple' && answer.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(answer);
      if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string' && !!item.trim())) return undefined;
      answers = parsed;
    } catch { return undefined; }
  }
  const indices: number[] = [];
  for (const value of answers) {
    const resolution = resolveOption(options, value, field.label, profile);
    if (resolution.status !== 'matched') return undefined;
    const index = options.indexOf(resolution.option);
    if (indices.includes(index)) return undefined;
    indices.push(index);
  }
  return indices;
}

async function choiceState(page: ApplicationScope, field: Field) {
  const selector = field.choice?.nativeSelect ? `[data-ja-field="${field.key}"] option` : `[data-ja-choice="${field.key}"]`;
  return page.locator(selector).evaluateAll(elements => elements.map(el => {
    const nativeInput = el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type);
    const native = nativeInput || el instanceof HTMLOptionElement;
    const state = nativeInput ? el.indeterminate ? null : el.checked : el instanceof HTMLOptionElement ? el.selected :
      el.getAttribute(el.hasAttribute('aria-pressed') ? 'aria-pressed' : el.getAttribute('role') === 'option' ? 'aria-selected' : 'aria-checked');
    const checked = native ? state : state === 'true' ? true : state === 'false' ? false : null;
    const unsafeButton = (el instanceof HTMLButtonElement && !!el.form && el.type !== 'button') ||
      (el instanceof HTMLInputElement && !!el.form && ['submit', 'reset', 'image'].includes(el.type));
    return { checked, requiredUnchecked: el instanceof HTMLInputElement && el.type === 'checkbox' && el.required && !el.checked,
      disabled: unsafeButton || el.matches(':disabled') || !!el.closest('[aria-disabled="true"],[aria-readonly="true"],[inert]') ||
      (el instanceof HTMLInputElement && el.readOnly) || (el instanceof HTMLOptionElement && !!el.closest('optgroup[disabled]')) };
  })).catch(() => []);
}

export async function choiceMatches(page: ApplicationScope, field: Field, answer: string, profile: Profile): Promise<boolean> {
  const expected = choiceTargets(field, answer, profile);
  if (!expected) return false;
  const states = await choiceState(page, field);
  const count = field.choice?.mode === 'boolean' ? 1 : field.options?.length ?? 0;
  return count > 0 && states.length === count && states.every((state, index) => typeof state.checked === 'boolean' && state.checked === expected.includes(index));
}

export async function choiceHasValue(page: ApplicationScope, field: Field): Promise<boolean> {
  const states = await choiceState(page, field);
  if (states.some(state => state.checked === null || state.requiredUnchecked)) return false;
  const selected = states.flatMap((state, index) => state.checked ? [index] : []);
  if (field.choice?.mode === 'single' && selected.length !== 1) return false;
  if (!selected.length) return false;
  if (field.choice?.nativeSelect) return page.locator(`[data-ja-field="${field.key}"]`).evaluate(el => {
    return [...(el as HTMLSelectElement).selectedOptions].every(option => !!option.value && !/^(select|choose|please select|please choose)( an option)?\.*$/i.test(option.label.trim()));
  }).catch(() => false);
  return true;
}

/** One interaction per discovery pass, so rerendered siblings are never clicked by stale index. */
export async function applyChoice(page: ApplicationScope, field: Field, answer: string, profile: Profile): Promise<boolean> {
  const expected = choiceTargets(field, answer, profile);
  if (!expected) return false;
  const states = await choiceState(page, field);
  const count = field.choice?.mode === 'boolean' ? 1 : field.options?.length ?? 0;
  if (!count || states.length !== count || states.some(state => state.checked === null)) return false;
  const changes = states.flatMap((state, index) => state.checked !== expected.includes(index) ? [index] : []);
  // Validate the complete set before changing anything, including stale selected disabled options.
  if (changes.some(index => states[index].disabled)) return false;
  if (!changes.length) return true;
  if (field.choice?.nativeSelect) {
    await page.locator(`[data-ja-field="${field.key}"]`).selectOption(expected.map(index => ({ index })), { timeout: 2000 });
  } else {
    const index = field.choice?.mode === 'single' ? expected[0] : changes[0];
    if (index === undefined) return false;
    const control = page.locator(`[data-ja-choice="${field.key}"]`).nth(index);
    if (await control.evaluate(el => el.matches('input[type="checkbox"],input[type="radio"]'))) {
      if (await control.isVisible()) await control.setChecked(expected.includes(index), { timeout: 2000 });
      else {
        // Styled controls may hide the input. Click its unique rendered label; never force a hidden input.
        const marker = `choice-${field.key}-${index}`;
        const labels = await control.evaluate((el, marker) => {
          const labels = [...((el as HTMLInputElement).labels ?? [])].filter(label => label.getClientRects().length && getComputedStyle(label).visibility !== 'hidden');
          if (labels.length === 1) labels[0].setAttribute('data-ap-choice-label', marker);
          return labels.length;
        }, marker);
        if (labels !== 1) return false;
        await page.locator(`[data-ap-choice-label="${marker}"]`).click({ timeout: 2000 });
      }
    } else await control.click({ timeout: 2000 });
  }
  return choiceMatches(page, field, answer, profile);
}
