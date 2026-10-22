import type { Frame } from 'playwright';
// A success-looking CSS class, icon, login screen, or JobPosting JSON-LD is not
// evidence that the employer received an application.
export async function submissionMessages(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => {
    const messages = new Set<string>();
    for (const el of document.querySelectorAll('h1,h2,h3,[role="alert"],[role="status"],.application-form-success-container,.ia-PostApply,p')) {
      if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') continue;
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (text.length > 600 || !text) continue;
      if (/^(thank you for (applying|your application)|thanks for applying|(?:your )?application (?:has been |was )?(submitted|received|sent)|successfully applied|you(?:'ve| have) (?:successfully )?applied|we (?:have |'ve )?received your application)\b/i.test(text)) messages.add(text);
    }
    return [...messages];
  });
}
