import { jobKey } from './detect.js';
import type { QueuedJob } from './types.js';

type QueueOptions = {
  live: boolean;
  limit: number;
  reload: () => Promise<QueuedJob[]>;
  shouldSkip: (url: string) => boolean;
};

/** A Notion batch uses only the current top N, refreshed at each selection. */
export async function* selectJobQueue(initial: QueuedJob[], options: QueueOptions): AsyncGenerator<QueuedJob> {
  const attemptedUrls = new Set<string>();
  const attemptedPages = new Set<string>();
  let processed = 0;
  while (processed < options.limit) {
    // Refresh failures propagate; never fall back to stale URLs or archived rows.
    const jobs = options.live ? (await options.reload()).slice(0, options.limit) : initial;
    const job = jobs.find(candidate => {
      let key: string;
      try { key = jobKey(candidate.url); } catch { return false; }
      return !attemptedUrls.has(key) && !options.shouldSkip(key) &&
        (!candidate.notion || !attemptedPages.has(candidate.notion.pageId));
    });
    if (!job) return;
    attemptedUrls.add(jobKey(job.url));
    if (job.notion) attemptedPages.add(job.notion.pageId);
    processed++;
    yield job;
  }
}
