import type { ATS } from './types.js';
import { annotateFields, detectFrameATS, adapterFor, adapterControl } from './simplify.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Frame, Page } from 'playwright';

// Run every browser inspection locally: this module makes no LLM calls.
export type ApplicationScope = Frame;

type Probe = {
  visibleFields: number;
  forms: number;
  hasIdentityLabels: boolean;
  hasApplicationText: boolean;
  sampleFields: Array<{ tag: string; type: string; id: string; name: string; role: string; placeholder: string }>;
};

async function probeFrame(frame: Frame): Promise<Probe | null> {
  try {
    return await frame.evaluate(() => {
      const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        'input, select, textarea, [role="combobox"], [role="radio"], [role="checkbox"], [role="switch"], [role="listbox"], [aria-pressed]'
      ));
      const visible = controls.filter(el => {
        const input = el as HTMLInputElement;
        if (input.type === 'hidden' || input.type === 'submit' || input.type === 'file') return false;
        const style = getComputedStyle(el);
        return el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
      const text = document.body?.innerText ?? '';
      const hasIdentityLabels = /first\s*name/i.test(text) && /last\s*name/i.test(text) && /e-?mail/i.test(text);
      const hasApplicationText = /apply for this job|apply for this position|submit application|submit your application/i.test(text);
      return {
        visibleFields: visible.length,
        forms: document.querySelectorAll('form').length,
        hasIdentityLabels,
        hasApplicationText,
        sampleFields: controls.slice(0, 30).map(el => ({
          tag: el.tagName.toLowerCase(), type: (el as HTMLInputElement).type || '',
          id: el.id, name: el.getAttribute('name') ?? '',
          role: el.getAttribute('role') ?? '', placeholder: el.getAttribute('placeholder') ?? ''
        }))
      };
    });
  } catch {
    // The frame may be in the middle of navigation or may have been detached.
    return null;
  }
}

// Greenhouse's modern UI may use text inputs without conventional name/type attributes,
// and some application widgets are embedded in iframes. Wait for *rendered controls*.
export async function findApplicationScope(page: Page, timeoutMs = 15000, expectedATS?: ATS | null): Promise<ApplicationScope | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = page.frames();
    for (const frame of frames) {
      const ats = await detectFrameATS(frame) ?? expectedATS;
      if (ats) {
        await annotateFields(frame, ats);
        if (await frame.locator('[data-ap-key], [data-ap-label]').filter({ visible: true }).count()) return frame;
        if (await frame.locator('[data-ap-scope]').filter({ visible: true }).count() && (adapterFor(ats)?.scopeSelector || await adapterControl(frame, ats, 'continue') || await adapterControl(frame, ats, 'submit'))) return frame;
      }
      const probe = await probeFrame(frame);
      if (!probe) continue;
      if (probe.visibleFields >= 3 && (probe.hasIdentityLabels || (probe.hasApplicationText && probe.visibleFields >= 6))) {
        return frame;
      }
    }
    await page.waitForTimeout(400);
  }
  return null;
}

// Only capture metadata about fields, not their values or the user's personal details.
export async function saveDetectionDiagnostics(page: Page, jobUrl: string): Promise<string> {
  const jobId = (new URL(jobUrl).pathname.split('/').filter(Boolean).pop() || 'job').replace(/[^a-zA-Z0-9_-]/g, '');
  const dir = path.resolve('output/debug');
  await fs.mkdir(dir, { recursive: true });
  const filename = path.join(dir, `${jobId}-${Date.now()}.json`);
  const frames = await Promise.all(page.frames().map(async frame => ({
    url: frame.url(),
    probe: await probeFrame(frame)
  })));
  const payload = {
    jobUrl,
    finalUrl: page.url(),
    title: await page.title().catch(() => ''),
    frames,
    detectedAt: new Date().toISOString()
  };
  await fs.writeFile(filename, JSON.stringify(payload, null, 2), { mode: 0o600 });
  // Optional screenshot shows loading errors/cookie overlays; kept local and gitignored.
  await page.screenshot({ path: filename.replace(/\.json$/, '.png'), timeout: 4000 })
    .catch(() => undefined);
  return path.relative(process.cwd(), filename);
}
