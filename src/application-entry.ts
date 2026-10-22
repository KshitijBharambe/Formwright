import { findApplicationScope } from './form-detection.js';
import type { Page, Frame, Locator } from 'playwright';
import type { ATS } from './types.js';
import { adapterControl, detectFrameATS } from './simplify.js';
import { boardFromUrl, isJobDetail, isYCJobListing } from './sites.js';
import { inspectVerification } from './verification.js';

export class ApplicationHandoff extends Error {
  constructor(public reason: 'login' | 'verification' | 'one_click' | 'navigation', message: string) { super(message); }
}
export async function detectHandoff(page: Page): Promise<ApplicationHandoff | null> {
  if ((await inspectVerification(page)).interactive) return new ApplicationHandoff('verification', 'Complete the visible human verification, then resume.');
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame() && (await inspectVerification(frame)).interactive) return new ApplicationHandoff('verification', 'Complete the visible human verification, then resume.');
    if (await frame.locator('input[autocomplete="one-time-code"]').filter({ visible: true }).count()) {
      return new ApplicationHandoff('verification', 'Complete the account verification code manually, then resume.');
    }
    const headings = await frame.locator('h1,h2,[role="heading"]').filter({ visible: true }).allTextContents();
    if (/verify (?:your )?(?:email|identity)|check your (?:email|inbox)|verification code|two.factor|multi.factor/i.test(headings.join(' '))) {
      return new ApplicationHandoff('verification', 'Complete account verification manually, then resume.');
    }
    const login = await frame.evaluate(() => {
      const visible = (el: Element) => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
      if ([...document.querySelectorAll('input[type="password"]')].some(visible)) return true;
      const heading = [...document.querySelectorAll('h1,h2,[role="heading"]')].filter(visible).map(el => el.textContent || '').join(' ');
      return /\b(sign ?in|log ?in|create (an? )?account|sign ?up|register|verify your (email|identity)|verification code|check your (email|inbox))\b/i.test(heading) &&
        [...document.querySelectorAll<HTMLInputElement>('input')].filter(visible).some(input => {
          if (input.type === 'email' || input.autocomplete === 'username' || input.name === 'session_key') return true;
          if (!['text', ''].includes(input.type)) return false;
          const labels = [...(input.labels ?? [])].map(label => label.textContent).join(' ');
          const aria = (input.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
          return /email|e.mail|username|user.name/i.test([labels, aria, input.getAttribute('aria-label'), input.name, input.id, input.placeholder].join(' '));
        });
    }).catch(() => false);
    if (login) return new ApplicationHandoff('login', 'Sign in or complete account verification in the browser, then resume.');
  }
  return null;
}
export type HandoffHandler = (page: Page, handoff: ApplicationHandoff) => Promise<void>;
export async function requireApplicationAccess(page: Page, handler?: HandoffHandler, allowHumanChallenge = false): Promise<boolean> {
  const handoff = await detectHandoff(page);
  if (!handoff) return false;
  // Once an application form is established, ordinary approved fields can be
  // filled with a CAPTCHA present. Password and OTP steps remain auth gates.
  if (allowHumanChallenge && handoff.reason === 'verification' && (await inspectVerification(page)).interactive) {
    let accountFields = false;
    for (const frame of page.frames()) if (await frame.locator('input[type="password"],input[autocomplete="one-time-code"]').filter({ visible: true }).count()) accountFields = true;
    if (!accountFields) return false;
  }
  if (!handler) throw handoff;
  await handler(page, handoff);
  const remaining = await detectHandoff(page);
  if (remaining) throw remaining;
  return true;
}
async function uniqueVisible(locator: Locator): Promise<Locator | null> {
  // A link wrapping a button is one action, not two ambiguous controls.
  const indices = await locator.evaluateAll(elements => {
    const visible = elements.map((el, index) => ({ el, index })).filter(({ el }) =>
      el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const actions = visible.filter(({ el }) => !visible.some(other => other.el !== el && other.el.contains(el)));
    if (actions.length > 1) {
      // Header/footer links to the same destination are one navigation choice.
      const hrefs = actions.map(({ el }) => el instanceof HTMLAnchorElement ? el.href : null);
      if (hrefs[0] && hrefs.every(href => href === hrefs[0]) && /^https?:/.test(hrefs[0]) &&
        new URL(hrefs[0]).href !== location.href && !new URL(hrefs[0]).hash) return [actions[0].index];
    }
    return actions.map(({ index }) => index);
  });
  return indices.length === 1 ? locator.nth(indices[0]) : null;
}
async function startControl(page: Frame, ats: ATS | null): Promise<Locator | null> {
  if (isYCJobListing(page.url())) {
    const role = await uniqueVisible(page.getByRole('link', { name: /^apply to role\s*[›»→]?$/i }).or(page.getByRole('button', { name: /^apply to role\s*[›»→]?$/i })));
    if (role) return role;
    throw new ApplicationHandoff('navigation', 'YC role-specific Apply control was not found. The global Apply link is for startup founders and will not be followed.');
  }
  const board = boardFromUrl(page.url());
  const selectors = board === 'LinkedIn' ? ['.jobs-apply-button', 'button[aria-label*="Easy Apply"]', 'a.jobs-apply-button'] :
    board === 'Indeed' ? ['#indeedApplyButton', '#applyButtonLinkContainer a', '[data-testid="indeedApplyButton"]', '[data-testid="apply-button"]'] :
    board === 'ZipRecruiter' ? ['[data-testid="apply-button"]', 'button[data-testid="quick-apply-button"]', 'a[data-testid="apply-button"]'] : [];
  for (const css of selectors) {
    const found = await uniqueVisible(page.locator(css));
    if (found) return found;
  }
  const option = await adapterControl(page, ats, 'applyOption');
  if (option) return option;
  const configured = await adapterControl(page, ats, 'apply');
  if (configured) return configured;
  const generic = page.getByRole('button', { name: /^(easy apply|apply|apply now|apply manually|apply for this job|apply to this job|apply for this position|apply to this position|apply on company (website|site)|continue application|quick apply)$/i }).or(
    page.getByRole('link', { name: /^(easy apply|apply|apply now|apply manually|apply for this job|apply to this job|apply for this position|apply to this position|apply on company (website|site)|continue application|quick apply)$/i }));
  const found = await uniqueVisible(generic);
  if (!found && await generic.filter({ visible: true }).count() > 1) {
    throw new ApplicationHandoff('navigation', 'Multiple different Apply actions are visible. Choose the intended application manually.');
  }
  return found;
}
async function applicationReady(frame: Frame, ats: ATS | null): Promise<boolean> {
  const root = await frame.locator('[data-ap-scope]').count() ? frame.locator('[data-ap-scope]') : frame.locator('html');
  const fields = root.locator('input:not([type="hidden"]):not([type="submit"]):not([type="button"]),select,textarea,[role="combobox"],[role="radio"],[role="checkbox"],[role="switch"],[role="listbox"],[aria-pressed]').filter({ visible: true });
  if (await fields.count() >= 2) return true;
  if (await adapterControl(frame, ats, 'continue') || await adapterControl(frame, ats, 'submit')) return true;
  return await root.getByRole('button', { name: /^(submit application|submit your application|send application)$/i }).filter({ visible: true }).count() === 1;
}
async function submissionControl(control: Locator, frame: Frame, ats: ATS | null): Promise<boolean> {
  const final = await adapterControl(frame, ats, 'submit');
  if (final && await control.evaluate((el, other) => !!other && (el === other || el.contains(other) || other.contains(el)), await final.elementHandle())) return true;
  return control.evaluate(el => {
    const button = el.matches('button,input') ? el as HTMLButtonElement : el.querySelector<HTMLButtonElement>('button,input[type="submit"]');
    // Native form submits labelled Apply are final actions too, even without ATS selectors.
    return !!button && button.type === 'submit' && !!button.form;
  });
}
export async function openApplication(initial: Page, initialATS: ATS | null, handler?: HandoffHandler): Promise<{ page: Page; ats: ATS }> {
  let page = initial;
  let ats = initialATS;
  let clicks = 0;
  let deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    // YC's job CTA opens an applicant dialog with a human challenge. Its
    // established form can be filled before handing verification to the user.
    if (isYCJobListing(page.url())) {
      const application = await findApplicationScope(page, 250, 'YCombinator');
      if (application && await applicationReady(application, 'YCombinator') &&
        !await application.locator('input[type="password"],input[autocomplete="one-time-code"]').filter({ visible: true }).count()) return { page, ats: 'YCombinator' };
    }
    if (await requireApplicationAccess(page, handler)) deadline = Date.now() + 20000;
    const board = boardFromUrl(page.url());
    if (board && !isJobDetail(page.url())) throw new ApplicationHandoff('navigation', 'Use a specific job listing URL, rather than a job search or board homepage.');
    let detected: ATS | null = null;
    for (const frame of page.frames()) { detected = await detectFrameATS(frame); if (detected) break; }
    ats = detected ?? (board || ats);
    const scope = await findApplicationScope(page, 250, ats);
    // A real form or review stage is ready; an empty shell or one newsletter
    // field is not. Persistent header Apply links must not restart a ready form.
    if (scope && await applicationReady(scope, ats)) return { page, ats: ats ?? 'Unknown' };
    let control: Locator | null = null;
    let controlFrame = page.mainFrame();
    for (const frame of page.frames()) {
      control = await startControl(frame, await detectFrameATS(frame) ?? ats);
      if (control) { controlFrame = frame; break; }
    }
    // A listing can expose contact/newsletter fields or an empty application
    // wrapper. Follow its Apply action before accepting either as an application.
    if (!control) {
      if (scope && await applicationReady(scope, ats)) return { page, ats: ats ?? 'Unknown' };
      for (const frame of page.frames()) if (await frame.getByRole('button', { name: /1.click apply|one.click apply/i }).filter({ visible: true }).count()) {
        throw new ApplicationHandoff('one_click', 'This listing exposes immediate one-click submission. Review and submit it manually.');
      }
      await page.waitForTimeout(300); continue;
    }
    if (await submissionControl(control, controlFrame, await detectFrameATS(controlFrame) ?? ats)) {
      if (scope && await applicationReady(scope, ats)) return { page, ats: ats ?? 'Unknown' };
      throw new ApplicationHandoff('one_click', 'The Apply control would submit a form. Review it manually.');
    }
    if (clicks >= 5) throw new ApplicationHandoff('navigation', 'Application routing reached its click limit; inspect the current page.');
    const label = `${await control.innerText().catch(() => '')} ${await control.getAttribute('aria-label') ?? ''}`;
    if (/1.click|one.click|submit|send application/i.test(label)) throw new ApplicationHandoff('one_click', 'The entry control submits immediately; review it manually.');
    const popup = page.waitForEvent('popup', { timeout: 1500 }).catch(() => null);
    await control.click({ timeout: 5000 });
    const opened = await popup;
    if (opened) { page = opened; page.setDefaultTimeout(6000); }
    await page.waitForLoadState('domcontentloaded', { timeout: 7000 }).catch(() => {});
    await page.waitForTimeout(300);
    clicks++;
  }
  throw new ApplicationHandoff('navigation', 'Could not find a supported application form or a unique Apply control. Inspect the current page.');
}
