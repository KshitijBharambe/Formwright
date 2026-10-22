import { siteAdapters, scopeSelectorFor } from './sites.js';
import { readFileSync, existsSync } from 'node:fs';
import type { Frame, Locator } from 'playwright';
import type { ATS } from './types.js';

type Paths = string | string[];
interface InputRule { path?: Paths; hidden?: boolean; actions?: InputRule[]; method?: string }
interface TrackedRule { fieldPath?: Paths; labelPath?: Paths; inputPath?: Paths; optionsPath?: Paths; optionsTextPath?: Paths; inputTextPath?: Paths }
export interface Adapter {
  scopeSelector?: string;
  urls?: string[]; helpMessageUrls?: string[]; urlsExcluded?: string[]; embeddedPaths?: string[][]; pathsExcluded?: string[][];
  containerPath?: Paths; containerRequired?: boolean;
  inputSelectors?: [string, (InputRule | string)[]][]; trackedInputSelectors?: TrackedRule[];
  applyButtonPaths?: Paths; applyOptionPaths?: Paths; continueButtonPaths?: Paths; submitButtonPaths?: Paths; submittedSuccessPaths?: Paths;
}
let cached: Record<string, Adapter> | undefined;
export function adapters(): Record<string, Adapter> {
  if (cached) return cached;
  const filename = new URL('../config/simplify-rules.json', import.meta.url);
  if (!existsSync(filename)) return cached = { ...siteAdapters };
  const data = JSON.parse(readFileSync(filename, 'utf8'));
  if (data.schemaVersion !== 1 || !data.ats || typeof data.ats !== 'object') throw new Error('Invalid Simplify rule file; reimport it.');
  const combined: Record<string, Adapter> = { ...data.ats };
  for (const [key, site] of Object.entries(siteAdapters)) combined[key] = { ...combined[key], ...site };
  return cached = combined;
}
export const adapterFor = (ats?: ATS | null): Adapter | undefined => ats ? adapters()[ats] : undefined;
export function matchesUrl(pattern: string, rawUrl: string): boolean {
  const parts = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!parts) return false;
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (parts[1] !== '*' && parts[1] + ':' !== url.protocol) return false;
    const glob = (value: string) => new RegExp('^' + value.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    const host = parts[2].includes(':') ? url.host : url.hostname;
    const matchesHost = glob(parts[2]).test(host) || (parts[2].startsWith('*.') && host === parts[2].slice(2));
    return matchesHost && glob(parts[3]).test(url.pathname + url.search + url.hash);
  } catch { return false; }
}
export function configuredATS(raw: string): ATS | null {
  for (const [key, adapter] of Object.entries(adapters())) {
    if ([...(adapter.urls ?? []), ...(adapter.helpMessageUrls ?? [])].some(p => matchesUrl(p, raw)) && !adapter.urlsExcluded?.some(p => matchesUrl(p, raw))) return key;
  }
  return null;
}
export async function detectFrameATS(frame: Frame): Promise<ATS | null> {
  const direct = configuredATS(frame.url());
  if (direct) return direct;
  // DOM probes allow hosted forms embedded in an employer's own domain.
  for (const [key, adapter] of Object.entries(adapters())) {
    if (!adapter.embeddedPaths?.length || adapter.urlsExcluded?.some(p => matchesUrl(p, frame.url()))) continue;
    const found = await frame.evaluate(({ groups, exclusions }) => {
      const exists = (p: string) => {
        try { return document.evaluate(p, document, null, XPathResult.BOOLEAN_TYPE).booleanValue; }
        catch { return false; }
      };
      return groups.some(g => g.length > 0 && g.every(exists)) && !exclusions.some(g => g.length > 0 && g.every(exists));
    }, { groups: adapter.embeddedPaths, exclusions: adapter.pathsExcluded ?? [] }).catch(() => false);
    if (found) return key;
  }
  return null;
}

// This bridges Simplify's semantic field paths to ordinary Playwright controls.
// It deliberately does not evaluate action programs, templates, or remote URLs.
export async function annotateFields(frame: Frame, ats?: ATS | null): Promise<void> {
  const adapter = adapterFor(ats);
  if (!adapter) return;
  await frame.evaluate(config => {
    document.querySelectorAll('[data-ap-scope]').forEach(el => el.removeAttribute('data-ap-scope'));
    document.querySelectorAll('[data-ap-key], [data-ap-label], [data-ap-options], [data-ap-selected], [data-ap-wrapper], [data-ap-wrapper-root]').forEach(el => {
      for (const attr of ['data-ap-key', 'data-ap-label', 'data-ap-options', 'data-ap-selected', 'data-ap-wrapper', 'data-ap-wrapper-root']) el.removeAttribute(attr);
    });
    const paths = (p: string | string[] | undefined): string[] => typeof p === 'string' ? [p] : Array.isArray(p) ? p.filter(s => typeof s === 'string') : [];
    const query = (p: string | string[] | undefined, root: Node): Element[] => {
      for (const xpath of paths(p)) {
        if (/%[A-Z_]+%|\{\{|\/shadow-root\//.test(xpath)) continue;
        try {
          const result = document.evaluate(xpath, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
          const found: Element[] = [];
          for (let i = 0; i < result.snapshotLength; i++) {
            const el = result.snapshotItem(i);
            if (el instanceof Element) found.push(el);
          }
          if (found.length) return found;
        } catch { /* Unsupported XPath stays unresolved. */ }
      }
      return [];
    };
    const controlSelector = 'input:not([type="hidden"]),select,textarea,[role="combobox"],[role="radio"],[role="checkbox"],[role="switch"],[aria-pressed],[role="listbox"],[contenteditable="true"],button[aria-haspopup="listbox"]';
    const scoped = config.scopeSelector ? [...document.querySelectorAll(config.scopeSelector)].filter(el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden') : [];
    if (config.scopeSelector && !scoped.length) return;
    const outerScopes = scoped.filter(el => !scoped.some(other => other !== el && other.contains(el)));
    if (config.scopeSelector && outerScopes.length !== 1) return;
    const roots = outerScopes.length ? outerScopes : query(config.containerPath, document);
    for (const root of roots) root.setAttribute('data-ap-scope', 'true');
    if (config.containerRequired && !roots.length) return;
    const containers: Node[] = roots.length ? roots : [document];
    const eligible = (el: Element) => !el.closest('[data-automation-id="signInContent"], [data-automation-id="createAccountContent"]');
    for (const [key, rules] of config.inputSelectors ?? []) {
      if (/^(begin|wait_|resume_begin)/.test(key)) continue;
      if (!Array.isArray(rules)) continue;
      for (const raw of rules) {
        const rule = typeof raw === 'string' ? { path: raw } : raw;
        if (!rule || rule.hidden) continue;
        for (const root of containers) for (const found of query(rule.path, root)) {
          let controls = found.matches(controlSelector) ? [found] : [...found.querySelectorAll(controlSelector)];
          // A wrapper containing several fields cannot safely identify one profile value.
          if (key === 'resume' || key === 'coverLetter') controls = controls.filter(el => el.matches('input[type="file"]'));
          if (controls.length !== 1) continue;
          if (eligible(controls[0]) && !controls[0].hasAttribute('data-ap-key')) controls[0].setAttribute('data-ap-key', key);
        }
      }
    }
    let index = 0;
    for (const rule of config.trackedInputSelectors ?? []) for (const root of containers) for (const wrapper of query(rule.fieldPath, root)) {
      const label = query(rule.labelPath, wrapper).map(el => el.textContent?.trim() ?? '').filter(Boolean).join(' ').replace(/\s+/g, ' ');
      const candidates = query(rule.inputPath, wrapper);
      const inputs = candidates.flatMap(el => el.matches(controlSelector) ? [el] : [...el.querySelectorAll(controlSelector)]);
      // Radio/checkbox groups need the question label; do not treat option text as the question.
      for (const control of new Set(inputs)) {
        if (!eligible(control)) continue;
        if (label) control.setAttribute('data-ap-label', label.slice(0, 1000));
        if (rule.optionsPath) control.setAttribute('data-ap-options', JSON.stringify(paths(rule.optionsPath)));
        if (rule.inputTextPath) {
          const selected = query(rule.inputTextPath, wrapper).map(el => el.textContent?.trim()).filter(Boolean).join(', ');
          if (selected) control.setAttribute('data-ap-selected', selected);
        }
        control.setAttribute('data-ap-wrapper', String(index));
        wrapper.setAttribute('data-ap-wrapper-root', String(index));
      }
      index++;
    }
  }, { ...adapter, scopeSelector: scopeSelectorFor(ats!, frame.url(), adapter.scopeSelector) });
  if (ats === 'Lever') await frame.locator('[data-ap-scope] #location-input').evaluateAll(elements => {
    for (const el of elements) if (el.parentElement?.querySelector('input#selected-location[type="hidden"]')) {
      el.setAttribute('data-ap-lever-location', 'true');
    }
  });
}

export async function adapterControl(frame: Frame, ats: ATS | null | undefined, kind: 'apply' | 'applyOption' | 'continue' | 'submit' | 'success'): Promise<Locator | null> {
  const adapter = adapterFor(ats);
  const raw = adapter?.[({ apply: 'applyButtonPaths', applyOption: 'applyOptionPaths', continue: 'continueButtonPaths', submit: 'submitButtonPaths', success: 'submittedSuccessPaths' } as const)[kind]];
  const paths = typeof raw === 'string' ? [raw] : raw ?? [];
  for (const xpath of paths) {
    if (/%[A-Z_]+%|\{\{|\/shadow-root\//.test(xpath)) continue;
    const root = adapter?.scopeSelector && kind !== 'success' && kind !== 'apply' && kind !== 'applyOption' ? frame.locator('[data-ap-scope]') : frame.locator('html');
    if (adapter?.scopeSelector && kind !== 'success' && kind !== 'apply' && kind !== 'applyOption' && !await root.count()) continue;
    const locator = root.locator(`xpath=${xpath}`);
    try {
      const count = await locator.count();
      const visible: Locator[] = [];
      for (let i = 0; i < Math.min(count, 20); i++) if (await locator.nth(i).isVisible()) visible.push(locator.nth(i));
      if (visible.length === 1) return visible[0];
    } catch { /* Try the next static selector. */ }
  }
  return null;
}
