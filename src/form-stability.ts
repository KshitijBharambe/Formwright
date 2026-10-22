import type { ApplicationScope } from './form-detection.js';

// Read DOM properties as well as attributes: controlled inputs can reset their
// value without a mutation event. Snapshots stay in memory and are never logged.
async function snapshot(page: ApplicationScope): Promise<string> {
  return page.evaluate(() => {
    const roots: ParentNode[] = [...document.querySelectorAll('[data-ap-scope]')];
    if (!roots.length) roots.push(document);
    const controls = [...new Set(roots.flatMap(root => [...root.querySelectorAll(
      'input, select, textarea, [role="radio"], [role="checkbox"], [role="switch"], [aria-pressed], [role="listbox"], [role="option"], [role="combobox"], [contenteditable="true"], button[aria-haspopup="listbox"], [data-ap-wd-prompt]'
    )]))];
    return JSON.stringify(controls.filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' ||
      el.matches('input[type="file"], input#selected-location[type="hidden"]')).map(el => {
      const input = el as HTMLInputElement;
      const referenced = (name: string) => (el.getAttribute(name) ?? '').split(/\s+/)
        .map(id => document.getElementById(id)?.textContent ?? '');
      return [el.tagName, el.id, input.name, input.type, input.value, input.checked, input.disabled, input.readOnly,
        input.indeterminate, input instanceof HTMLSelectElement ? [...input.options].map(option => [option.label, option.selected, option.disabled]) : undefined,
        input.required, el.getAttribute('role'), el.getAttribute('aria-required'), el.getAttribute('aria-invalid'),
        el.getAttribute('aria-checked'), el.getAttribute('aria-pressed'), el.getAttribute('aria-selected'),
        el.getAttribute('aria-disabled'), el.getAttribute('aria-readonly'), el.getAttribute('aria-busy'), el.getAttribute('aria-expanded'), el.getAttribute('aria-label'),
        el.getAttribute('placeholder'), referenced('aria-labelledby'), referenced('aria-describedby'),
        [...(input.labels ?? [])].map(label => label.textContent),
        el.closest('fieldset')?.querySelector('legend')?.textContent,
        el.matches('select, button, [contenteditable="true"]') ? el.textContent : undefined,
        [...(input.files ?? [])].map(file => file.name)];
    }));
  });
}

/** A bounded quiet window, not a claim about future server-side changes. */
export async function waitForFormStability(page: ApplicationScope): Promise<boolean> {
  const deadline = Date.now() + 2000;
  let previous = await snapshot(page);
  let unchangedSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const current = await snapshot(page);
    if (current !== previous) { previous = current; unchangedSince = Date.now(); }
    else if (Date.now() - unchangedSince >= 450) return true;
  }
  return false;
}
