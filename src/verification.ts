import type { Page, Frame } from 'playwright';

/**
 * Report only interactive verification challenges, not the mere presence of
 * Greenhouse's passive/invisible reCAPTCHA widget or its badge iframe.
 *
 * This deliberately does NOT solve, click, or interfere with verification.
 * It's a conservative visual/structural heuristic, not a CAPTCHA solver.
 */
export async function inspectVerification(page: Page | Frame): Promise<{
  interactive: boolean;
  passiveWidgets: number;
  reasons: string[];
}> {
  return page.evaluate(() => {
    const reasons: string[] = [];
    let passiveWidgets = 0;

    const isRendered = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 &&
        style.display !== 'none' && style.visibility !== 'hidden';
    };
    const intersectsViewport = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
    };

    for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe')) {
      const src = (frame.getAttribute('src') ?? '').toLowerCase();
      const title = (frame.title ?? '').toLowerCase();
      const provider = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com/.test(src + ' ' + title);
      if (!provider || !isRendered(frame)) continue;

      const r = frame.getBoundingClientRect();
      if (!intersectsViewport(frame)) {
        passiveWidgets++;
        continue;
      }

      // A reCAPTCHA challenge frame is a separate, large overlay.
      if (/recaptcha/.test(src + ' ' + title)) {
        if (/\/bframe(?:\?|$)/.test(src) && r.width >= 250 && r.height >= 180) {
          reasons.push('Visible reCAPTCHA challenge window');
          continue;
        }
        // Checkbox reCAPTCHA is typically a 300x75 visible control.
        // The invisible reCAPTCHA badge is typically 256x60 and is passive.
        if (/\/anchor(?:\?|$)/.test(src) &&
            r.width >= 280 && r.height >= 65 &&
            !frame.closest('[data-size="invisible"], .grecaptcha-badge')) {
          reasons.push('Visible reCAPTCHA checkbox');
          continue;
        }
        passiveWidgets++;
        continue;
      }

      // hCaptcha explicit challenge overlays, not just an included iframe.
      if (/hcaptcha/.test(src + ' ' + title)) {
        if (r.width >= 250 && r.height >= 170 && /challenge|frame=challenge/.test(src + ' ' + title)) {
          reasons.push('Visible hCaptcha challenge window');
          continue;
        }
        if (r.width >= 280 && r.height >= 65 && r.height < 150 && /checkbox/.test(src + ' ' + title)) {
          reasons.push('Visible hCaptcha checkbox');
          continue;
        }
        passiveWidgets++;
        continue;
      }

      // Cloudflare Turnstile is often managed/invisible. Merely loading its
      // iframe cannot establish whether user interaction is needed.
      passiveWidgets++;
    }

    // Look for an actual on-screen verification prompt, avoiding raw
    // `body.innerText` (which can include passive/footer messages).
    const checks = document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [role="checkbox"], .h-captcha, .cf-turnstile'
    );
    for (const el of checks) {
      if (!isRendered(el) || !intersectsViewport(el)) continue;
      const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
      if (/^(i['’]?m not a robot|i am human|verify (you are|that you are) human)$/i.test(text)) {
        reasons.push('Visible human-verification prompt');
        break;
      }
    }

    return { interactive: reasons.length > 0, passiveWidgets, reasons };
  });
}
