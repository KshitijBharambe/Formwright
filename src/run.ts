import { supplementalAnswers } from './application-answers.js';
import { accountHandoffHandler } from './account-auth.js';
import { loadAuthSettings } from './auth-settings.js';
import { concurrencyFromArgs, runConcurrent } from './concurrency.js';
import { loadAutofillSettings, type AutofillSettings } from './autofill-settings.js';
import { LocalAnswerResolver } from './local-resolver.js';
import { selectJobQueue } from './job-queue.js';
import { loadAnswerSnapshot, type AnswerSnapshot } from './answer-source.js';
import { loadJobQueue } from './job-source.js';
import { openApplication, ApplicationHandoff, type HandoffHandler } from './application-entry.js';
import { boardFromUrl } from './sites.js';
import { fillJourney } from './journey.js';
import { chromium, type BrowserContext } from 'playwright';
import { pathToFileURL } from 'node:url';
import { waitForReview } from './browser-review.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { detectATS, jobKey } from './detect.js';
import { loadResults, saveResult, writeExceptionQueue } from './storage.js';
import { submitAndVerify } from './form.js';
import { inspectVerification } from './verification.js';
import { findApplicationScope, saveDetectionDiagnostics } from './form-detection.js';
import type { JobResult, Profile, QueuedJob } from './types.js';

async function readJSON<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}
const activeEmployers = new WeakMap<BrowserContext, Set<string>>();

export async function runJobs(args: Set<string>, options: {
  context?: BrowserContext;
  autofill?: AutofillSettings;
  applicationAnswers?: import('./types.js').AnswerBank;
  jobs?: QueuedJob[];
  waitForReview?: boolean;
  onResult?: (result: JobResult) => void;
  onInputs?: (profile: Profile, answers: AnswerSnapshot) => void;
} = {}) {
  const concurrency = concurrencyFromArgs(args);
  const submit = args.has('--submit');
  const advance = args.has('--advance');
  const maxSteps = Number([...args].find(x => x.startsWith('--max-steps='))?.split('=')[1] ?? 8);
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 30) throw new Error('--max-steps must be an integer from 1 to 30');
  const visible = args.has('--visible');
  const keepOpen = visible && !submit;
  const pauseOnError = args.has('--pause-on-error');
  const pauseOnUnresolved = args.has('--pause-on-unresolved');
  if (pauseOnError && !visible) throw new Error('--pause-on-error requires --visible');
  if (pauseOnUnresolved && !visible) throw new Error('--pause-on-unresolved requires --visible');
  const manualHandoff: HandoffHandler | undefined = visible && pauseOnUnresolved ? async (activePage, handoff) => {
    console.log(`Manual step: ${handoff.message} Press Resume in Playwright Inspector when done.`);
    await activePage.pause();
  } : undefined;
  const retryUncertain = args.has('--retry-uncertain');
  const limitArg = [...args].find(x => x.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
  if (!(limit > 0)) throw new Error('--limit must be a positive number');
  const jobs = options.jobs ?? await loadJobQueue(args);
  if (options.applicationAnswers && jobs.length !== 1) throw new Error('Application-specific answers require exactly one application.');
  if (args.has('--list-jobs')) {
    console.log(JSON.stringify(jobs.slice(0, limit), null, 2));
    return;
  }
  if (!jobs.length) { console.log('No jobs matched the selected source.'); return; }
  const autofill = options.autofill ?? await loadAutofillSettings(args);
  const profile = await readJSON<Profile>('config/profile.json');
  const answerSnapshot = await loadAnswerSnapshot();
  const auth = await loadAuthSettings();
  options.onInputs?.(profile, answerSnapshot);
  if (!profile.email || profile.email.endsWith('@example.com') || profile.firstName.startsWith('YOUR_')) {
    throw new Error('Fill config/profile.json with your verified information first.');
  }
  const results = await loadResults();
  const context = options.context ?? await chromium.launchPersistentContext(path.resolve('.browser'), {
    headless: !visible, viewport: { width: 1366, height: 900 },
    acceptDownloads: false
  });
  let claims = activeEmployers.get(context);
  if (!claims) { claims = new Set(); activeEmployers.set(context, claims); }
  try {
    let processed = 0;
    const live = args.has('--notion') || args.has('--source=notion');
    const queue = selectJobQueue(jobs, {
      live, limit, reload: () => loadJobQueue(args),
      shouldSkip: url => {
        const previous = results.get(url);
        return previous?.status === 'submitted' || (previous?.status === 'needs_verification' && !retryUncertain);
      }
    });
    async function* preparedJobs() {
      for await (const job of queue) {
        const currentProfile = processed ? await readJSON<Profile>('config/profile.json') : profile;
        const currentAnswers = processed ? await loadAnswerSnapshot() : answerSnapshot;
        if (!currentProfile.email || currentProfile.email.endsWith('@example.com') || currentProfile.firstName.startsWith('YOUR_')) {
          throw new Error('Fill config/profile.json with your verified information first.');
        }
        options.onInputs?.(currentProfile, currentAnswers);
        yield { job, profile: currentProfile, answers: supplementalAnswers(currentAnswers.effective, options.applicationAnswers), sequence: ++processed };
      }
    }
    await runConcurrent(preparedJobs(), concurrency, async ({ job, profile, answers, sequence }) => {
      const raw = job.url;
      const url = jobKey(raw);
      const handleHandoff = accountHandoffHandler(auth, profile, manualHandoff);
      console.log(`[${sequence}] ${url}`);
      const resolver = new LocalAnswerResolver(autofill, profile, answers);
      let ats = detectATS(raw);
      let result: JobResult;
      const ownedPages = new Set<import('playwright').Page>();
      const trackPage = (opened: import('playwright').Page) => {
        ownedPages.add(opened);
        opened.on('popup', trackPage);
      };
      let page = await context.newPage();
      trackPage(page);
      let employerClaim: string | undefined;
      let submissionAttempted = false;
      let resolvedUrl = url;
      page.setDefaultTimeout(6000);
      try {
        await page.goto(raw, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(200);
        const entry = await openApplication(page, ats, handleHandoff);
        page = entry.page;
        ats = entry.ats;
        const resolvedKey = jobKey(page.url());
        resolvedUrl = resolvedKey;
        const latestResults = await loadResults();
        const matching = [...latestResults.values()].find(r => (r.url === resolvedKey || (r.resolvedUrl && jobKey(r.resolvedUrl) === resolvedKey)) &&
          (r.status === 'submitted' || (r.status === 'needs_verification' && !retryUncertain)));
        if (matching) throw new ApplicationHandoff('navigation', 'This employer application was already processed from another listing; review the existing result before retrying.');
        if (claims!.has(resolvedKey)) throw new ApplicationHandoff('navigation', 'Another tab is already filling this employer application. Review that tab.');
        claims!.add(resolvedKey); employerClaim = resolvedKey;
        const scope = await findApplicationScope(page, 15000, ats);
        if (!scope) {
          const debugFile = await saveDetectionDiagnostics(page, raw);
          throw new Error(`Application controls not detected after 15 seconds. Browser diagnostics: ${debugFile}`);
        }
        // Fill FIRST. A passive/invisible reCAPTCHA widget does not prevent
        // ordinary form filling, and should not block a dry run.
        const journey = await fillJourney(page, scope, profile, answers, ats, advance, maxSteps, handleHandoff, resolver);
        const { filled, missing } = journey;
        ats = journey.ats;
        const verification = await inspectVerification(page);
        if (missing.length) {
          result = { url, ats: ats ?? undefined, status: 'needs_answers', message: `${missing.length} field(s) or action(s) unresolved`, timestamp: new Date().toISOString(), fieldsFilled: filled, missing };
        } else if (verification.interactive) {
          result = { url, ats: ats ?? undefined, status: 'needs_answers',
            message: `Interactive human verification required: ${verification.reasons.join(', ')}. Complete manually; automation will not solve it.`,
            timestamp: new Date().toISOString(), fieldsFilled: filled };
        } else if (!submit) {
          result = { url, ats: ats ?? undefined, status: 'ready_for_review',
            message: verification.passiveWidgets
              ? `Dry run: fields filled; ${verification.passiveWidgets} passive verification widget(s) detected, but no interactive challenge. Submission not attempted.`
              : 'Dry run: fields filled, submission not attempted',
            timestamp: new Date().toISOString(), fieldsFilled: filled };
        } else {
          // An interactive challenge can also appear AFTER clicking submit.
          // Without an unambiguous confirmation, never claim success or
          // automatically resubmit this application.
          const confirmed = await submitAndVerify(journey.scope, ats, () => { submissionAttempted = true; });
          result = { url, ats: ats ?? undefined, status: confirmed ? 'submitted' : 'needs_verification',
            message: confirmed ? 'Visible application confirmation detected' : 'Clicked submit; could not prove submission (possibly validation or verification). Do NOT auto-resubmit.',
            timestamp: new Date().toISOString(), fieldsFilled: filled };
        }
        result.steps = journey.steps;
        result.resolvedUrl = resolvedKey;
        result.entrySite = boardFromUrl(raw) ?? undefined;
        if (pauseOnUnresolved && (result.status === 'needs_answers' || result.status === 'needs_verification')) {
          console.log('Paused on unresolved application; inspect the open form. Resume when finished.');
          await page.pause();
        }
      } catch (err) {
        // Record the page actually reached even when entry/authentication fails.
        try { resolvedUrl = jobKey(page.url()); } catch { /* Keep the last valid URL. */ }
        result = { url, ats: ats ?? undefined, resolvedUrl, entrySite: boardFromUrl(raw) ?? undefined, status: submissionAttempted ? 'needs_verification' : err instanceof ApplicationHandoff ? 'needs_answers' : 'error',
          message: err instanceof Error ? err.message : String(err), timestamp: new Date().toISOString(),
          ...(err instanceof ApplicationHandoff ? { missing: [{ label: err.message, type: err.reason }] } : {}) };
        if (err instanceof ApplicationHandoff && visible && pauseOnUnresolved) await page.pause();
        if (pauseOnError) {
          console.warn('Paused on error. Inspect the browser in Playwright Inspector, then press Resume to continue.');
          await page.pause();
        }
      } finally {
        if (!keepOpen) for (const opened of ownedPages) await opened.close().catch(() => {});
      }
      if (job.notion) result.notion = job.notion;
      results.set(url, result);
      result.autofill = resolver.report;
      try {
        await saveResult(result);
        await writeExceptionQueue(results);
        options.onResult?.(result);
      } finally {
        if (employerClaim) claims!.delete(employerClaim);
      }
      console.log(`  -> ${result.status}: ${result.message}`);
    });
    const counts = [...results.values()].reduce<Record<string, number>>((obj, r) => {
      obj[r.status] = (obj[r.status] ?? 0) + 1;
      return obj;
    }, {});
    console.log('\nCumulative results:', counts);
    console.log('History: output/results.jsonl | Exceptions: output/exceptions.json');
    if (keepOpen && processed > 0 && options.waitForReview !== false) {
      console.log('Forms are open for review. Press Enter here or close the browser to finish.');
      await waitForReview(context);
    }
  } finally {
    if (!options.context) await context.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runJobs(new Set(process.argv.slice(2))).catch(error => { console.error(error); process.exitCode = 1; });
}
