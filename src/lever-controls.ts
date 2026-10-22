import type { ApplicationScope } from './form-detection.js';
import type { Field, Profile } from './types.js';
import { chosenOption } from './field-matching.js';

// Lever's plain text input is a search query. The sibling hidden input is
// populated by a suggestion click; never write it ourselves.
export async function leverLocationCommitted(page: ApplicationScope, field: Field): Promise<boolean> {
  return page.locator(`[data-ja-field="${field.key}"]`).evaluate(el => {
    const input = el as HTMLInputElement;
    const selected = el.parentElement?.querySelector<HTMLInputElement>('input#selected-location[type="hidden"]');
    let proof: { text?: string; value?: string } = {};
    try { proof = JSON.parse(el.getAttribute('data-ap-lever-selection') || '{}'); } catch {}
    return el.getAttribute('aria-invalid') !== 'true' && !!selected?.value &&
      proof.value === selected.value && proof.text === input.value.trim();
  }).catch(() => false);
}

export async function fillLeverLocation(page: ApplicationScope, field: Field, answer: string, profile: Profile): Promise<boolean> {
  const input = page.locator(`[data-ja-field="${field.key}"]`);
  try {
    const before = await input.evaluate(el => el.parentElement?.querySelector<HTMLInputElement>('input#selected-location[type="hidden"]')?.value || '');
    await input.fill(answer, { timeout: 2000 });
    const options = input.locator('..').locator('.dropdown-results .dropdown-location:visible');
    const deadline = Date.now() + 2500;
    let labels: string[] = [];
    do {
      await page.waitForTimeout(150);
      labels = (await options.allTextContents()).map(label => label.trim());
      if (labels.length) break;
    } while (Date.now() < deadline);
    await input.evaluate((el, labels) => el.setAttribute('data-ap-known-options', JSON.stringify(labels)), labels);
    const match = chosenOption(labels, answer, field.label, profile);
    if (!match) { await input.fill(''); await input.blur(); return false; }
    const index = labels.indexOf(match);
    await options.nth(index).click({ timeout: 2000 });
    // Wait for the widget to commit, retaining the full hidden payload only in
    // the page. A rejected click or stale hidden value cannot become proof.
    const commitDeadline = Date.now() + 1000;
    do {
      const committed = await input.evaluate((el, { match, before }) => {
        const value = el.parentElement?.querySelector<HTMLInputElement>('input#selected-location[type="hidden"]')?.value;
        if (!value || value === before || (el as HTMLInputElement).value.trim() !== match || el.getAttribute('aria-invalid') === 'true') return false;
        el.setAttribute('data-ap-lever-selection', JSON.stringify({ text: match, value }));
        return true;
      }, { match, before });
      if (committed) return true;
      await page.waitForTimeout(100);
    } while (Date.now() < commitDeadline);
    return false;
  } catch { return false; }
}
