import type { ApplicationScope } from './form-detection.js';
import type { Field } from './types.js';

/** Discover question owners separately from option labels. No applicant values leave the browser. */
export async function inspectFields(page: ApplicationScope): Promise<Field[]> {
  return page.evaluate(() => {
    document.querySelectorAll('[data-ja-field],[data-ja-choice],[data-ja-radio],[data-ap-choice-label]').forEach(el => {
      for (const attr of ['data-ja-field', 'data-ja-choice', 'data-ja-radio', 'data-ap-choice-label']) el.removeAttribute(attr);
    });
    const roots: ParentNode[] = [...document.querySelectorAll('[data-ap-scope]')];
    if (!roots.length) roots.push(document);
    const selector = 'input,select,textarea,[role="combobox"],[role="radio"],[role="checkbox"],[role="switch"],button[aria-pressed],[role="button"][aria-pressed],[role="listbox"],[contenteditable="true"],button[aria-haspopup="listbox"],[data-ap-wd-prompt]';
    const controls = [...new Set(roots.flatMap(root => [...root.querySelectorAll<HTMLElement>(selector)]))];
    const seen = new Set<Element>();
    const out: Field[] = [];
    const text = (el: Element | null): string => el?.textContent?.trim().replace(/\s+/g, ' ') ?? '';
    const visible = (el: Element): boolean => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden],[aria-hidden="true"],[inert]');
    const ariaLabel = (el: Element): string => {
      const refs = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
      return refs.map(id => text(document.getElementById(id))).filter(Boolean).join(' ') || el.getAttribute('aria-label') || '';
    };
    const ownLabel = (el: Element): string => ariaLabel(el) ||
      [...((el as HTMLInputElement).labels ?? [])].map(text).filter(Boolean).join(' ') ||
      text(el.closest('label')) || (el.matches('[role="radio"],[role="checkbox"],[role="switch"],[aria-pressed],[role="option"]') ? text(el) : '');
    const labelOf = (el: Element): string => el.getAttribute('data-ap-label') || ownLabel(el) ||
      el.getAttribute('placeholder') || (el.getAttribute('name') || el.id || '').replace(/[\[\]_-]+/g, ' ').trim();
    const kindOf = (el: Element): string => {
      if (el.matches('input[type="radio"],[role="radio"]')) return 'radio';
      if (el.matches('input[type="checkbox"],[role="checkbox"]')) return 'checkbox';
      if (el.matches('[role="switch"]')) return 'switch';
      if (el.matches('[aria-pressed]')) return 'toggle';
      if (el.matches('[role="listbox"]')) return el.getAttribute('aria-multiselectable') === 'true' ? 'multilistbox' : 'listbox';
      if (el.matches('[contenteditable="true"]')) return 'contenteditable';
      if (el.hasAttribute('data-ap-lever-location')) return 'combobox';
      if (el.matches('[data-ap-wd-prompt],[role="combobox"],button[aria-haspopup="listbox"]')) return 'combobox';
      if (el instanceof HTMLInputElement) return el.type;
      if (el instanceof HTMLSelectElement) return el.multiple ? 'select-multiple' : 'select';
      return 'textarea';
    };
    const groupOf = (el: Element): Element | null => el.closest('[role="radiogroup"]') || el.closest('[role="group"],fieldset') ||
      el.closest('[data-ap-wrapper-root],.form-field,.field,.field-wrapper,.application-question,[data-automation-id^="formField"]') ||
      (el.id ? [...document.querySelectorAll('[role="radiogroup"][aria-owns],[role="group"][aria-owns]')].find(group => (group.getAttribute('aria-owns') || '').split(/\s+/).includes(el.id)) ?? null : null);
    const formOf = (el: Element): Element | null => el instanceof HTMLInputElement ? el.form : el.closest('form');
    const groupLabel = (group: Element | null): string => group ? group.getAttribute('data-ap-label') || ariaLabel(group) ||
      text(group.querySelector(':scope > legend')) || text([...group.querySelectorAll('label')].find(label => !label.hasAttribute('for') && !label.querySelector(selector)) ?? null) : '';
    const rendered = (el: Element): boolean => visible(el) || (el.matches('input[type="radio"],input[type="checkbox"]') &&
      !el.closest('[hidden],[aria-hidden="true"],[inert]') && [...((el as HTMLInputElement).labels ?? [])].some(visible));
    // Some forms render a question as plain text above a named radio group.
    // Only use the nearest small owner containing this group and no other fields.
    const radioQuestion = (el: Element, members: Element[]): { owner: Element; label: string } | undefined => {
      const optionLabels = new Set(members.map(ownLabel).filter(Boolean));
      for (let owner = el.parentElement, depth = 0; owner && depth < 5 && !owner.matches('form,body,[role="dialog"]'); owner = owner.parentElement, depth++) {
        const fields = [...owner.querySelectorAll(selector)];
        if (fields.some(field => !members.includes(field)) || owner.querySelector('button:not([role="radio"]),a')) break;
        if (!members.every(member => owner!.contains(member))) continue;
        const copy = owner.cloneNode(true) as Element;
        copy.querySelectorAll('input,[role="radio"],script,style,[hidden],[aria-hidden="true"]').forEach(node => node.remove());
        const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
        const parts: string[] = [];
        while (walker.nextNode()) {
          const value = walker.currentNode.textContent?.trim().replace(/\s+/g, ' ') || '';
          if (value && !optionLabels.has(value)) parts.push(value);
        }
        const label = parts.join(' ').trim();
        if (label && label.length <= 500 && !/^(yes|no|true|false)(\s+(yes|no|true|false))*$/i.test(label)) return { owner, label };
      }
      return undefined;
    };
    const domKey = (el: Element): string => {
      const parts: string[] = [];
      for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
        if (node.id) { parts.unshift(`#${node.id}`); break; }
        parts.unshift(`${node.tagName}:${node.parentElement ? [...node.parentElement.children].indexOf(node) : 0}`);
      }
      return parts.join('/');
    };
    for (const el of controls) {
      if (seen.has(el)) continue;
      let kind = kindOf(el);
      if (['hidden', 'button', 'submit', 'reset', 'image'].includes(kind)) continue;
      if (el.closest('[data-automation-id="signInContent"],[data-automation-id="createAccountContent"]')) continue;
      if (el.matches('[role="combobox"]') && el.querySelector('[role="combobox"]')) continue;
      // ARIA wrappers backed by a native input are one control, not two answers.
      if (el.matches('[role="radio"],[role="checkbox"],[role="switch"]') && el.querySelector('input[type="radio"],input[type="checkbox"]')) continue;
      if (!rendered(el) && kind !== 'file') continue;
      const group = groupOf(el);
      let label = labelOf(el);
      let owner: Element = el;
      let members: Element[] = [el];
      let options: string[] | undefined;
      let choice: Field['choice'];
      if (kind === 'radio' || kind === 'checkbox' || kind === 'toggle' || kind === 'switch') {
        const name = el.getAttribute('name') || '';
        const related = controls.filter(other => kindOf(other) === kind &&
          groupOf(other) === group && formOf(other) === formOf(el) &&
          (kind !== 'radio' || (name ? other.getAttribute('name') === name : !!group)) &&
          !(other.matches('[role="radio"],[role="checkbox"],[role="switch"]') && other.querySelector('input[type="radio"],input[type="checkbox"]')));
        const question = el.getAttribute('data-ap-label') || groupLabel(group);
        if (kind === 'radio' || (kind !== 'switch' && group && question && related.length > 1)) {
          members = related.length ? related : [el];
          // Invisible alternate layouts must not introduce duplicate options.
          members = members.filter(rendered);
          if (!members.length) continue;
          owner = group ?? el;
          label = question || name;
          if (kind === 'radio' && !question) {
            const discovered = radioQuestion(el, members);
            if (discovered) { owner = discovered.owner; label = discovered.label; }
          }
          options = members.map(member => ownLabel(member) || (member as HTMLInputElement).value || '');
          choice = { mode: kind === 'radio' ? 'single' : 'multiple' };
          if (kind !== 'radio') kind = 'checkbox-group';
        } else choice = { mode: 'boolean' };
      } else if (kind === 'listbox' || kind === 'multilistbox') {
        // Menus belonging to a combobox are handled by that widget's adapter.
        if (el.closest('[role="combobox"]') || controls.some(control => control !== el && control.matches('[role="combobox"],[aria-haspopup="listbox"],[data-ap-wd-prompt]') &&
          ['aria-controls', 'aria-owns'].some(attr => (control.getAttribute(attr) || '').split(/\s+/).includes(el.id)))) continue;
        members = [...el.querySelectorAll('[role="option"]')].filter(option => option.closest('[role="listbox"]') === el);
        options = members.map(option => ownLabel(option) || text(option));
        choice = { mode: kind === 'multilistbox' ? 'multiple' : 'single' };
      } else if (kind === 'select' || kind === 'select-multiple') {
        // Keep disabled entries in the candidate set: ambiguity cannot be hidden by disabling an option.
        options = [...(el as HTMLSelectElement).options].map(option => option.label.trim());
        choice = { mode: kind === 'select-multiple' ? 'multiple' : 'single', nativeSelect: true };
      } else if (kind === 'combobox') {
        try {
          const known: unknown = JSON.parse(el.getAttribute('data-ap-known-options') || 'null');
          if (Array.isArray(known) && known.every(option => typeof option === 'string')) options = known;
        } catch {}
      }
      if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || (el as HTMLInputElement).readOnly || el.getAttribute('aria-readonly') === 'true') {
        // A disabled first option must not hide the rest of an enabled question.
        if (!choice || choice.mode === 'boolean' || choice.nativeSelect || members.every(member => member.matches(':disabled,[aria-disabled="true"],[aria-readonly="true"]'))) continue;
      }
      const key = String(out.length);
      el.setAttribute('data-ja-field', key);
      if (choice && !choice.nativeSelect) for (const member of members) { member.setAttribute('data-ja-choice', key); seen.add(member); }
      const required = /[*✱]|\(required\)/i.test(label) || [owner, ...members].some(member =>
        member.hasAttribute('required') || member.hasAttribute('data-ap-wd-required') || member.getAttribute('aria-required') === 'true');
      const context = groupLabel(group);
      out.push({ key, label, kind, required, options, choice, instanceKey: domKey(owner),
        leverLocation: el.hasAttribute('data-ap-lever-location'),
        workdayPrompt: el.hasAttribute('data-ap-wd-prompt'), workdayManaged: !!el.closest('[data-ap-wd-row]'),
        semanticKey: el.getAttribute('data-ap-key') ?? undefined, name: el.getAttribute('name') ?? undefined,
        id: el.id || undefined, placeholder: el.getAttribute('placeholder') ?? undefined, context: context.slice(0, 160) || undefined });
    }
    return out;
  });
}
