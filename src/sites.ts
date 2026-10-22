import type { Adapter } from './simplify.js';
export type JobBoard = 'LinkedIn' | 'Indeed' | 'ZipRecruiter';
const hasDomain = (host: string, domain: string) => host === domain || host.endsWith('.' + domain);
export function boardFromUrl(raw: string): JobBoard | null {
  try {
    const { hostname } = new URL(raw);
    if (hasDomain(hostname, 'linkedin.com')) return 'LinkedIn';
    if (['indeed.com', 'indeed.ca', 'indeed.co.uk', 'indeed.co.in', 'indeed.com.au'].some(domain => hasDomain(hostname, domain))) return 'Indeed';
    if (['ziprecruiter.com', 'ziprecruiter.co.uk'].some(domain => hasDomain(hostname, domain))) return 'ZipRecruiter';
  } catch {}
  return null;
}
export function isJobDetail(raw: string): boolean {
  const board = boardFromUrl(raw);
  if (!board) return true;
  const url = new URL(raw);
  if (board === 'LinkedIn') return /\/jobs\/view\/[^/]+|\/job-apply\//i.test(url.pathname) || url.searchParams.has('currentJobId');
  if (board === 'Indeed') return /\/viewjob|\/rc\/clk|\/pagead\/clk|\/indeedapply\/|\/apply\//i.test(url.pathname) || ['jk', 'vjk'].some(key => url.searchParams.has(key));
  return /\/c\/.+\/Job\/|\/jobs\/[^/]+\/[^/]+|\/job\/|\/apply(?:\/|$)/i.test(url.pathname) || ['jid', 'job_id', 'lvk'].some(key => url.searchParams.has(key));
}
export function isYCJobListing(raw: string): boolean {
  try { const url = new URL(raw); return hasDomain(url.hostname, 'ycombinator.com') && /^\/companies\/[^/]+\/jobs\/[^/]+\/?$/.test(url.pathname); }
  catch { return false; }
}
export const siteAdapters: Record<string, Adapter> = {
  Lever: {
    scopeSelector: 'form:has(#btn-submit), .application-form:has(#btn-submit)',
    trackedInputSelectors: [
      { fieldPath: './/*[contains(concat(" ",normalize-space(@class)," ")," application-question ")]',
        labelPath: ['.//*[contains(@class,"application-label")]//*[contains(@class,"text")]', './/*[contains(@class,"application-label")]'],
        inputPath: './/input[not(@type="hidden")]|.//select|.//textarea' }
    ]
  },
  YCombinator: {
    urls: ['*://*.ycombinator.com/companies/*/jobs/*'],
    scopeSelector: '[role="dialog"]:has(form input[name="first_name"]):has(form input[name="last_name"])',
    applyButtonPaths: ['.//a[contains(normalize-space(.),"Apply to role")]'],
    inputSelectors: [
      ['first_name', ['.//input[@name="first_name"]']], ['last_name', ['.//input[@name="last_name"]']],
      ['email', ['.//input[@type="email"]']], ['linkedin', ['.//input[starts-with(@placeholder,"Linkedin URL") or starts-with(@placeholder,"LinkedIn URL")]']],
      ['resume', ['.//input[@type="file"]']]
    ],
    submitButtonPaths: ['.//form//button[@type="submit" and normalize-space(.)="Submit"]']
  },
  Workday: { containerPath: ['//div[@data-automation-id="applyFlowReviewPage" or @data-automation-id="reviewJobApplicationPage"]', '//html[not(.//div[@data-automation-id="applyFlowReviewPage" or @data-automation-id="reviewJobApplicationPage"])]'], applyOptionPaths: ['//div[@data-automation-id="wd-popup-frame"]//a[@data-automation-id="applyManually"]'] },
  LinkedIn: {
    urls: ['*://*.linkedin.com/jobs/*', '*://*.linkedin.com/job-apply/*'],
    scopeSelector: '.jobs-easy-apply-modal, dialog:has([data-sdui-screen*="easyapply"]), [role="dialog"]:has(form)',
    continueButtonPaths: ['.//button[@data-easy-apply-next-button or @data-live-test-easy-apply-review-button or @aria-label="Continue to next step" or @aria-label="Review your application"]', './/button[normalize-space(.)="Next" or normalize-space(.)="Review"]'],
    submitButtonPaths: ['.//button[@data-live-test-easy-apply-submit-button or @aria-label="Submit application"]', './/button[normalize-space(.)="Submit application"]'],
    submittedSuccessPaths: ['.//*[@role="dialog"]//*[self::h2 or self::h3 or @role="alert"][contains(.,"application was sent")]']
  },
  Indeed: {
    urls: ['*://*.indeed.com/*', '*://*.indeed.ca/*', '*://*.indeed.co.uk/*', '*://*.indeed.co.in/*', '*://*.indeed.com.au/*'],
    // Indeed hosted apply pages often replace the complete document.
    scopeSelector: '#ia-container, .ia-ApplyForm, [data-testid="ia-apply-form"], form:has(button[data-testid="continue-button"]), form:has(button[data-testid="submit-application-button"]), [role="dialog"]:has(form)',
    continueButtonPaths: ['.//button[@data-testid="continue-button" or @data-testid="review-application-button"]', './/button[normalize-space(.)="Continue" or normalize-space(.)="Next" or normalize-space(.)="Review your application"]'],
    // Continue is intentionally not classified as final submission.
    submitButtonPaths: ['.//button[@data-testid="submit-application-button"]', './/button[normalize-space(.)="Submit your application" or normalize-space(.)="Submit application"]'],
    submittedSuccessPaths: ['.//*[self::h1 or self::h2 or @role="alert"][contains(.,"application has been submitted") or contains(.,"application was submitted")]']
  },
  ZipRecruiter: {
    urls: ['*://*.ziprecruiter.com/*', '*://*.ziprecruiter.co.uk/*'],
    scopeSelector: '[role="dialog"]:has(form), [role="dialog"]:has(button[data-testid="application-submit"]), form[data-testid*="apply" i], form[id*="apply" i], form[action*="apply" i], [data-testid="application-form"]',
    inputSelectors: [['full_name', ['.//input[@name="full_name"]']], ['first_name', ['.//input[@name="first_name"]']], ['last_name', ['.//input[@name="last_name"]']], ['email', ['.//input[@type="email"]']], ['resume', ['.//input[@type="file" and (contains(@name,"resume") or contains(@id,"resume"))]']]],
    continueButtonPaths: ['.//button[@data-testid="application-next" or @data-testid="application-review"]', './/button[normalize-space(.)="Next" or normalize-space(.)="Continue" or normalize-space(.)="Review application"]'],
    submitButtonPaths: ['.//button[@data-testid="application-submit"]', './/button[normalize-space(.)="Submit application" or normalize-space(.)="Submit Application" or normalize-space(.)="Send application"]'],
    submittedSuccessPaths: ['.//*[self::h1 or self::h2 or @role="alert"][contains(.,"Application submitted") or contains(.,"application has been submitted") or contains(.,"application was sent")]']
  }
};
export function scopeSelectorFor(ats: string, rawUrl: string, selector?: string): string | undefined {
  const url = new URL(rawUrl);
  if (ats === 'Indeed' && /(^|\.)smartapply\.indeed\./i.test(url.hostname)) return (selector ? selector + ',' : '') + 'form';
  if (ats === 'ZipRecruiter' && /\/apply(?:\/|$)/i.test(url.pathname)) return (selector ? selector + ',' : '') + 'form';
  return selector;
}
