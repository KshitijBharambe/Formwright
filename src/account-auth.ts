import type { BrowserContext, Frame, Locator, Page } from 'playwright';
import type { Profile } from './types.js';
import type { AuthSettings } from './auth-settings.js';
import { authSummary, credentialsAllowed } from './auth-settings.js';
import { ApplicationHandoff, detectHandoff, type HandoffHandler } from './application-entry.js';
import { inspectVerification } from './verification.js';

// Cookies are shared between application tabs. Serialize auth per origin so two
// tabs do not register the same account or race a rotating login session.
const locks = new WeakMap<BrowserContext, Map<string, Promise<void>>>();
const blockedAccounts = new WeakMap<BrowserContext, Map<string, { credentials: string; reason: 'login' | 'verification' }>>();
const loginNames = /^(sign in|log in|login|continue|next)$/i;
const signupNames = /^(create (?:an? )?account|sign up|register)$/i;
const verifyText = /\b(verify (?:your )?(?:email|identity)|verification code|one.time (?:code|password)|check your (?:email|inbox)|enter (?:the )?(?:security |verification )?code|two.factor|multi.factor|authenticator)\b/i;

type Surface = { frame: Frame; root: Locator; signup: boolean; signature: string };
async function surface(page: Page): Promise<Surface | null> {
  const found: Surface[] = [];
  for (const frame of page.frames()) {
    const meta = await frame.evaluate(() => {
      const visible = (el: Element) => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
      document.querySelectorAll('[data-ap-auth-root]').forEach(el => el.removeAttribute('data-ap-auth-root'));
      const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
      const headings = [...document.querySelectorAll('h1,h2,[role="heading"]')].filter(visible);
      const heading = headings.find(el => /\b(sign ?in|log ?in|create (an? )?account|sign ?up|register)\b/i.test(el.textContent || ''));
      const anchor = passwords[0] ?? heading;
      if (!anchor) return null;
      const root = anchor.closest('[role="dialog"],form') ?? document.body;
      if (!root) return null;
      const text = [...root.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible).map(el => el.textContent).join(' ');
      const context = text || heading?.textContent || '';
      if (/reset (?:your )?password|change (?:your )?password|forgot (?:your )?password/i.test(context)) return null;
      const actions = [...root.querySelectorAll('button,input[type="submit"]')].filter(visible).map(el => el.textContent?.trim() || (el as HTMLInputElement).value);
      const signup = /\b(create (an? )?account|sign ?up|register)\b/i.test(context) && !/\b(sign ?in|log ?in)\b/i.test(context) ||
        passwords.length === 2 || actions.some(text => /^(create (an? )?account|sign up|register)$/i.test(text || '')) && !actions.some(text => /^(sign in|log in|login)$/i.test(text || ''));
      const controls = [...root.querySelectorAll('input,select,textarea')].filter(visible);
      root.setAttribute('data-ap-auth-root', '');
      return { signup, signature: JSON.stringify([location.href, signup, controls.map(el => [el.tagName, el.id, el.getAttribute('name'), el.getAttribute('type')])]) };
    }).catch(() => null);
    if (meta) found.push({ frame, root: frame.locator('[data-ap-auth-root]'), ...meta });
  }
  if (found.length > 1) throw new ApplicationHandoff('login', 'Multiple account forms are visible. Choose the account form manually, then retry.');
  return found[0] ?? null;
}
async function hasVerification(page: Page): Promise<boolean> {
  if ((await inspectVerification(page)).interactive) return true;
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame() && (await inspectVerification(frame)).interactive) return true;
    if (await frame.locator('input[autocomplete="one-time-code"]').filter({ visible: true }).count()) return true;
    const text = await frame.locator('h1,h2,h3,[role="heading"],[role="alert"]').filter({ visible: true }).allTextContents();
    if (verifyText.test(text.join(' '))) return true;
  }
  return false;
}
async function hasFailure(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const text = await frame.locator('[role="alert"],.error,[data-automation-id*="error"],h1,h2').filter({ visible: true }).allTextContents();
    if (/invalid (?:email|password|credentials)|incorrect|account (?:not found|already exists)|unable to sign in|no account|email.*already|try again|too many attempts/i.test(text.join(' '))) return true;
  }
  return false;
}
async function fillAccountForm(view: Surface, settings: AuthSettings, profile: Profile) {
  // Inspect only control metadata. Credentials never enter an LLM or an error report.
  const fields = await view.root.locator('input,select,textarea').evaluateAll(elements => elements.map((el, index) => {
    const input = el as HTMLInputElement;
    const label = [...(input.labels ?? [])].map(label => label.textContent).join(' ');
    return { index, tag: el.tagName, type: input.type, required: input.required || el.getAttribute('aria-required') === 'true',
      visible: !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden',
      checked: input.checked, filled: !!input.value,
      hint: [label, (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '), el.getAttribute('aria-label'), el.id, el.getAttribute('name'), el.getAttribute('autocomplete'), el.getAttribute('placeholder')].join(' ') };
  }));
  let secrets = 0, usernames = 0;
  const assignments: Array<{ index: number; value: string }> = [];
  for (const field of fields.filter(field => field.visible && !['hidden', 'submit', 'button'].includes(field.type))) {
    let value: string | undefined;
    if (field.tag === 'INPUT' && field.type === 'password') { value = settings.password; secrets++; }
    else if (field.tag === 'INPUT' && (field.type === 'email' || /email|e.mail|username|user.name|session_key/i.test(field.hint))) { value = settings.username; usernames++; }
    else if (view.signup && field.tag === 'INPUT' && /first.?name|given.?name/i.test(field.hint)) value = profile.firstName;
    else if (view.signup && field.tag === 'INPUT' && /last.?name|family.?name|surname/i.test(field.hint)) value = profile.lastName;
    else if (view.signup && field.tag === 'INPUT' && /full.?name/i.test(field.hint)) value = profile.fullName;
    else if (field.required && !(field.type === 'checkbox' || field.type === 'radio' ? field.checked : field.filled)) {
      throw new ApplicationHandoff('login', 'Account form has a required field or consent that needs your review. Complete it manually, then retry.');
    }
    if (value !== undefined) assignments.push({ index: field.index, value });
  }
  if (usernames > 2 || secrets > (view.signup ? 2 : 1) || (!usernames && !secrets)) {
    throw new ApplicationHandoff('login', 'Account fields are ambiguous. Complete this account step manually, then retry.');
  }
  const name = view.signup ? signupNames : loginNames;
  const actions = view.root.getByRole('button', { name }).filter({ visible: true });
  if (await actions.count() !== 1) throw new ApplicationHandoff('login', 'No unique account action found. Complete this step manually, then retry.');
  // Do not post a credential form to an unapproved destination, even on a trusted page.
  const actionUrl = await actions.evaluate(el => {
    const control = el as HTMLButtonElement;
    return control.formAction && control.hasAttribute('formaction') ? control.formAction : control.form?.action || location.href;
  });
  if (!credentialsAllowed(actionUrl, settings)) throw new ApplicationHandoff('login', 'Account form posts to a hostname that is not allowed in account settings.');
  for (const assignment of assignments) {
    if (!credentialsAllowed(view.frame.page().url(), settings) || !credentialsAllowed(view.frame.url(), settings)) throw new ApplicationHandoff('login', 'Account hostname changed. Review this step manually.');
    await view.root.locator('input,select,textarea').nth(assignment.index).fill(assignment.value);
  }
  if (await hasVerification(view.frame.page())) throw new ApplicationHandoff('verification', 'Complete account verification manually, then retry.');
  if (!credentialsAllowed(view.frame.page().url(), settings) || !credentialsAllowed(view.frame.url(), settings)) throw new ApplicationHandoff('login', 'Account hostname changed. Review this step manually.');
  await actions.click({ timeout: 5000 });
}

async function authenticate(page: Page, settings: AuthSettings, profile: Profile) {
  for (let step = 0; step < 4; step++) {
    if (await hasVerification(page)) throw new ApplicationHandoff('verification', 'Complete CAPTCHA, MFA or email verification manually, then retry.');
    const current = await surface(page);
    if (!current) {
      if (await detectHandoff(page)) throw new ApplicationHandoff('login', 'Account access still needs your review. Complete it manually, then retry.');
      return;
    }
    if (!credentialsAllowed(page.url(), settings) || !credentialsAllowed(current.frame.url(), settings)) {
      throw new ApplicationHandoff('login', 'Automatic login is limited to HTTPS hostnames in account settings. Add this account hostname, then retry.');
    }
    if (current.signup && !settings.allowSignup) throw new ApplicationHandoff('login', 'Account creation is disabled. Enable signup in account settings or create the account manually.');
    if (await hasFailure(page)) throw new ApplicationHandoff('login', 'The site reported an account error. Review it manually; automatic login will not retry or create another account.');
    await fillAccountForm(current, settings, profile);
    // Wait for a real account-step transition; never repeatedly click a rejected login.
    let changed = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(200);
      if (await hasVerification(page)) throw new ApplicationHandoff('verification', 'Complete CAPTCHA, MFA or email verification manually, then retry.');
      if (await hasFailure(page)) throw new ApplicationHandoff('login', 'The site rejected the account step. Review it manually; no automatic retry or signup was attempted.');
      const next = await surface(page);
      if (!next || next.signature !== current.signature) { changed = true; break; }
    }
    if (!changed) throw new ApplicationHandoff('login', 'Account action was attempted once; no account-step transition was confirmed. Review the open tab.');
  }
  throw new ApplicationHandoff('login', 'Account workflow reached its step limit. Continue manually, then retry.');
}

export function accountHandoffHandler(settings: AuthSettings, profile: Profile, manual?: HandoffHandler): HandoffHandler | undefined {
  if (!settings.enabled) return async (page, handoff) => {
    const reason = handoff.reason === 'login' ? new ApplicationHandoff('login', authSummary(settings).message) : handoff;
    if (manual) await manual(page, reason);
    else throw reason;
  };
  return async (page, handoff) => {
    if (handoff.reason !== 'login') {
      if (manual) return manual(page, handoff);
      throw handoff;
    }
    let byOrigin = locks.get(page.context());
    if (!byOrigin) { byOrigin = new Map(); locks.set(page.context(), byOrigin); }
    const origin = new URL(page.url()).origin;
    let blocked = blockedAccounts.get(page.context());
    if (!blocked) { blocked = new Map(); blockedAccounts.set(page.context(), blocked); }
    // Memory-only identity. Changing account settings allows a corrected retry.
    const identity = JSON.stringify(settings);
    const previous = byOrigin.get(origin);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = (previous ?? Promise.resolve()).then(() => gate);
    byOrigin.set(origin, tail);
    try {
      await previous;
      // A sibling tab may have just established the session. Reuse it first.
      if (previous) await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 });
      const prior = blocked.get(origin);
      if (prior?.credentials === identity && await detectHandoff(page)) {
        throw new ApplicationHandoff(prior.reason, 'A sibling tab needs manual account review on this site. Resolve it or update the account settings before retrying.');
      }
      await authenticate(page, settings, profile);
      blocked.delete(origin);
    } catch (error) {
      const safe = error instanceof ApplicationHandoff ? error : new ApplicationHandoff('login', 'Automatic account access could not finish. Review the open tab, then retry.');
      if (manual) await manual(page, safe);
      else {
        if (safe.reason === 'verification' || /rejected|reported an account error|no account-step transition|sibling tab/i.test(safe.message)) {
          blocked.set(origin, { credentials: identity, reason: safe.reason === 'verification' ? 'verification' : 'login' });
        }
        throw safe;
      }
    } finally {
      release();
      if (byOrigin.get(origin) === tail) byOrigin.delete(origin);
    }
  };
}
