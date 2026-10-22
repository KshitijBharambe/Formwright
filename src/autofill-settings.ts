import { readFile } from 'node:fs/promises';

export interface AutofillSettings {
  mode: 'deterministic' | 'llm';
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxCalls: number;
}
export const defaultAutofillSettings: AutofillSettings = {
  mode: 'deterministic', baseUrl: 'http://127.0.0.1:1234/v1', model: '', timeoutMs: 15000, maxCalls: 12
};

export function validateAutofillSettings(input: unknown): AutofillSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Autofill settings must be an object.');
  const value = { ...defaultAutofillSettings, ...input };
  if (!['deterministic', 'llm'].includes(value.mode)) throw new Error('Choose deterministic or llm autofill.');
  const url = new URL(value.baseUrl);
  // Local inference only. No credentials, arbitrary paths, query strings or redirects.
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || !['/v1', '/v1/'].includes(url.pathname)) {
    throw new Error('Use a local LM Studio URL such as http://127.0.0.1:1234/v1.');
  }
  if (typeof value.model !== 'string' || value.model.length > 200 || /[\r\n]/.test(value.model)) throw new Error('Invalid model identifier.');
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 60000) throw new Error('timeoutMs must be 100–60000.');
  if (!Number.isInteger(value.maxCalls) || value.maxCalls < 1 || value.maxCalls > 30) throw new Error('maxCalls must be 1–30.');
  return { mode: value.mode, baseUrl: url.href.replace(/\/$/, ''), model: value.model.trim(), timeoutMs: value.timeoutMs, maxCalls: value.maxCalls };
}

export async function loadAutofillSettings(args = new Set<string>()): Promise<AutofillSettings> {
  let saved = {};
  try { saved = JSON.parse(await readFile('config/autofill.json', 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const config = validateAutofillSettings(saved);
  for (const arg of args) {
    if (arg.startsWith('--autofill=')) config.mode = arg.slice(11) as AutofillSettings['mode'];
    if (arg.startsWith('--lmstudio-url=')) config.baseUrl = arg.slice(15);
    if (arg.startsWith('--lmstudio-model=')) config.model = arg.slice(17);
  }
  return validateAutofillSettings(config);
}
