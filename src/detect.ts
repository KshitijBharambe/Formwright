import { boardFromUrl } from './sites.js';
import { configuredATS } from './simplify.js';
import type { ATS } from './types.js';

export function detectATS(rawUrl: string): ATS | null {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const board = boardFromUrl(rawUrl);
  if (board) return board;
  const configured = configuredATS(rawUrl);
  if (configured) return configured;
  const domain = url.hostname.toLowerCase();
  if (['boards.greenhouse.io', 'job-boards.greenhouse.io', 'boards.eu.greenhouse.io', 'job-boards.eu.greenhouse.io'].includes(domain)) return 'Greenhouse';
  if (['jobs.lever.co', 'jobs.eu.lever.co'].includes(domain)) return 'Lever';
  if (domain.endsWith('.myworkdayjobs.com') || domain.endsWith('.myworkdaysite.com')) return 'Workday';
  if (domain === 'jobs.ashbyhq.com') return 'AshbyHQ';
  return null;
}

// Preserve identity-bearing query parameters and remove only known attribution keys.
export function jobKey(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Expected an HTTP(S) job URL');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|source|ref|referrer|lever-source|gh_src)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/$/, '') || '/';
  return url.href;
}
