import type { Frame, Locator } from 'playwright';
import { chosenOption, resolveOption } from './field-matching.js';
import { optionSearchTerms } from './degree-matching.js';
export async function workdayCommitted(control: Locator, expected?: string, label = ''): Promise<boolean> {
  const selected = await control.evaluate(el => {
    const placeholder = /^(select|select one|choose|no items|no selection|search|please select|none selected)\.*$/i;
    const root = el.closest('[data-automation-id^="formField"], [data-automation-id="multiSelectContainer"], [data-uxi-widget-type="multiselect"]') || el.parentElement;
    const tokens = [...(root?.querySelectorAll('[data-automation-id="selectedItem"], [data-automation-id="selectedItemList"] [title]') ?? [])]
      .map(item => item.getAttribute('title') || item.textContent || '').map(s => s.trim()).filter(s => s && !placeholder.test(s));
    if (el.tagName === 'BUTTON') tokens.push((el.textContent || '').trim());
    const valid = tokens.filter(s => s && !placeholder.test(s));
    return [...new Set(valid)];
  }).catch(() => [] as string[]);
  return expected ? chosenOption(selected, expected, label) !== undefined : selected.length > 0;
}
export async function fillWorkdayPrompt(frame: Frame, control: Locator, value: string, label = ''): Promise<boolean> {
  // A path uses explicit parent > child choices supplied in the approved value.
  const parts = value.split(/\s+>\s+/).map(part => part.trim()).filter(Boolean);
  if (!parts.length || parts.length > 8) return false;
  const leaf = parts[parts.length - 1];
  const matchLabel = parts.length === 1 ? label : '';
  if (await workdayCommitted(control, leaf, matchLabel)) return true;
  try {
    await control.click({ timeout: 2500 });
    for (const part of parts) {
      const editable = await control.evaluate(el => el instanceof HTMLInputElement && !el.readOnly);
      if (editable) await control.fill(part);
      let chosen: Locator | undefined;
      const deadline = Date.now() + 4000;
      let searched = false;
      const queries = optionSearchTerms(part, matchLabel);
      let queryIndex = 0;
      let lastSearch = Date.now();
      while (Date.now() < deadline) {
        await frame.evaluate(() => {
          document.querySelectorAll('[data-ap-wd-option]').forEach(el => el.removeAttribute('data-ap-wd-option'));
          const visible = (el: Element) => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
          const popups = [...document.querySelectorAll('[data-automation-activepopup="true"], [data-automation-id="activeListContainer"], [role="listbox"]')].filter(visible);
          const roots = popups.filter(el => !popups.some(other => other !== el && other.contains(el)));
          if (roots.length !== 1) return;
          const all = [...roots[0].querySelectorAll('[role="option"], [data-automation-id="promptOption"], [data-automation-id="promptLeafNode"]')]
            .filter(el => visible(el) && !el.matches('[aria-disabled="true"], [disabled]'));
          all.filter(el => !all.some(other => other !== el && el.contains(other)))
            .forEach(el => el.setAttribute('data-ap-wd-option', 'true'));
        });
        const options = frame.locator('[data-ap-wd-option="true"]');
        const texts = await options.evaluateAll(els => els.map(el => el.getAttribute('title') || el.textContent || ''));
        const resolution = resolveOption(texts.map(text => text.trim()), part, matchLabel);
        if (resolution.status === 'ambiguous') { await control.press('Escape').catch(() => {}); return false; }
        if (resolution.status === 'matched') { chosen = options.nth(texts.findIndex(text => text.trim() === resolution.option)); break; }
        if (!editable && !searched) {
          const search = frame.locator('[data-automation-activepopup="true"] input:not([type="hidden"]), [role="listbox"] input, [data-automation-id="activeListContainer"] input').filter({ visible: true });
          if (await search.count() === 1) { await search.fill(part); searched = true; }
        }
        if (Date.now() - lastSearch >= 650 && queryIndex + 1 < queries.length) {
          const search = editable ? control : frame.locator('[data-automation-activepopup="true"] input:not([type="hidden"]), [role="listbox"] input, [data-automation-id="activeListContainer"] input').filter({ visible: true });
          if (await search.count() === 1) { await search.fill(queries[++queryIndex]); lastSearch = Date.now(); }
        }
        await frame.waitForTimeout(150);
      }
      if (!chosen) { await control.press('Escape').catch(() => {}); return false; }
      await chosen.click({ timeout: 2500 });
      await frame.waitForTimeout(150);
    }
    await control.press('Escape').catch(() => {});
    for (let i = 0; i < 10; i++) {
      if (await workdayCommitted(control, leaf, matchLabel)) return true;
      await frame.waitForTimeout(100);
    }
  } catch { return false; }
  return false;
}
export async function annotateWorkday(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const selectors = 'button[aria-haspopup="listbox"],button[aria-haspopup="true"],input[role="combobox"],input[data-automation-id="searchBox"], [data-automation-id="multiSelectContainer"] input';
    document.querySelectorAll(selectors).forEach(el => {
      if (el.closest('[data-automation-id="signInContent"], [data-automation-id="createAccountContent"]')) return;
      el.setAttribute('data-ap-wd-prompt', 'true');
    });
    document.querySelectorAll('input,select,textarea,button[data-ap-wd-prompt]').forEach(el => {
      const field = el.closest('[data-automation-id^="formField"]');
      if (!el.hasAttribute('data-ap-label')) {
        const label = field?.querySelector('label,legend,[data-automation-id="formLabel"]')?.textContent?.trim();
        if (label) el.setAttribute('data-ap-label', label);
      }
      if (field?.getAttribute('aria-required') === 'true' || /\*/.test(field?.querySelector('label,legend')?.textContent || '')) el.setAttribute('data-ap-wd-required', 'true');
    });
  });
}
