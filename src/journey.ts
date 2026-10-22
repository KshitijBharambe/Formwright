import type { LocalAnswerResolver } from './local-resolver.js';
import { workdayValidation } from './workday.js';
import { requireApplicationAccess, type HandoffHandler } from './application-entry.js';
import type { Page } from 'playwright';
import type { ATS, AnswerBank, Profile } from './types.js';
import { fillApplication } from './form.js';
import { findApplicationScope, type ApplicationScope } from './form-detection.js';
import { adapterControl, detectFrameATS } from './simplify.js';
import { inspectVerification } from './verification.js';
async function signature(frame: ApplicationScope): Promise<string> {
  return frame.evaluate(() => JSON.stringify({ url: location.href,
    fields: [...document.querySelectorAll('input:not([type="hidden"]), select, textarea, [role="combobox"]')]
      .filter(el => el.getClientRects().length)
      .map(el => [el.tagName, el.id, el.getAttribute('name'), el.getAttribute('aria-label'), el.getAttribute('type')]),
    heading: [...document.querySelectorAll('h1,h2,h3,h4,legend,label,[role="heading"],[aria-current="step"]')].map(el => el.textContent?.trim()) }));
}
export async function fillJourney(page: Page, initial: ApplicationScope, profile: Profile, bank: AnswerBank,
  initialATS: ATS | null, advance: boolean, maxSteps: number, handler?: HandoffHandler, resolver?: LocalAnswerResolver) {
  let scope = initial;
  let ats = initialATS;
  const filled = new Set<string>();
  for (let step = 1; step <= maxSteps; step++) {
    if (await requireApplicationAccess(page, handler, true)) {
      const resumed = await findApplicationScope(page, 1500, ats);
      if (!resumed) throw new Error('Account access resumed, but application controls were not detected.');
      scope = resumed;
    }
    ats = await detectFrameATS(scope) ?? ats;
    const result = await fillApplication(scope, profile, bank, ats, resolver);
    result.filled.forEach(label => filled.add(label));
    const finish = () => ({ ...result, filled: [...filled], scope, ats, steps: step });
    if (result.missing.length || (await inspectVerification(page)).interactive) return finish();
    const next = await adapterControl(scope, ats, 'continue');
    if (!next) {
      const final = await adapterControl(scope, ats, 'submit');
      const root = await scope.locator('[data-ap-scope]').count() ? scope.locator('[data-ap-scope]') : scope.locator('html');
      const genericSubmit = root.getByRole('button', { name: /^(submit application|submit your application|submit|send application)$/i }).filter({ visible: true });
      if (!final && await genericSubmit.count() !== 1) result.missing.push({ label: 'No unambiguous continuation or final submit control was found; inspect the current application step', type: 'navigation' });
      return finish();
    }
    const label = `${await next.innerText().catch(() => '')} ${await next.getAttribute('value') ?? ''} ${await next.getAttribute('aria-label') ?? ''}`;
    const final = await adapterControl(scope, ats, 'submit');
    const sameAsSubmit = final ? await next.evaluate((el, other) => el === other, await final.elementHandle()) : false;
    if (sameAsSubmit) return finish();
    if (!advance || step === maxSteps || /\b(submit|send application|finish|complete application)\b/i.test(label)) {
      result.missing.push({ label: !advance ? 'Application has another step; rerun with --advance or continue manually' : 'Continuation requires manual review or step limit reached', type: 'navigation' });
      return finish();
    }
    const before = await signature(scope);
    await next.click({ timeout: 5000 });
    const deadline = Date.now() + 12000;
    let progressed = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(400);
      if ((await inspectVerification(page)).interactive) break;
      if (await requireApplicationAccess(page, handler)) {
        const resumed = await findApplicationScope(page, 1500, ats);
        if (resumed) { scope = resumed; progressed = true; break; }
      }
      const candidate = await findApplicationScope(page, 500, ats);
      if (candidate && await signature(candidate) !== before) { scope = candidate; progressed = true; break; }
    }
    if (!progressed) {
      if (ats === 'Workday') result.missing.push(...await workdayValidation(scope));
      result.missing.push({ label: 'Continue did not produce a new form step; review validation or verification', type: 'navigation' });
      return finish();
    }
  }
  throw new Error('Unexpected journey exit');
}
