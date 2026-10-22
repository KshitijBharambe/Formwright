import { applicationQuestions } from './application-answers.js';
import { loadNotionJobs, updateNotionJob, type NotionConfig } from './notion.js';
import { runConcurrent, validateConcurrency } from './concurrency.js';
import { authSummary, loadAuthSettings, saveAuthSettings } from './auth-settings.js';
import { defaultAutofillSettings, loadAutofillSettings, validateAutofillSettings, type AutofillSettings } from './autofill-settings.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { jobKey } from './detect.js';
import { loadJobQueue } from './job-source.js';
import { loadAnswerSnapshot, type AnswerSnapshot } from './answer-source.js';
import { loadResults } from './storage.js';
import type { AnswerBank, JobResult, Profile, QueuedJob } from './types.js';

type Source<T> = { data: T; fetchedAt?: string; error?: string };
type Task = { job: QueuedJob; state: 'queued' | 'running' | 'done' | 'error' | 'interrupted'; updatedAt: string; message?: string };
type Persisted = { version: 1; manual: QueuedJob[]; tasks: Task[]; advance: boolean; autofill?: AutofillSettings; concurrency?: number; tracked?: QueuedJob[]; removed?: string[]; responses?: Record<string, AnswerBank>; tracking?: Record<string, { status?: string; lifecycle?: string }> };
export type Processor = (job: QueuedJob, advance: boolean, onInputs: (profile: Profile, answers: AnswerSnapshot) => void, autofill: AutofillSettings, applicationAnswers?: AnswerBank) => Promise<JobResult | undefined>;
const alphabetical = (a: QueuedJob, b: QueuedJob) =>
  (a.notion?.company || a.notion?.title || new URL(a.url).hostname).localeCompare(b.notion?.company || b.notion?.title || new URL(b.url).hostname, 'en', { sensitivity: 'base', numeric: true }) ||
  (a.notion?.title || '').localeCompare(b.notion?.title || '', 'en', { sensitivity: 'base', numeric: true }) || a.url.localeCompare(b.url, 'en');
const now = () => new Date().toISOString();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function optionalJSON(file: string): Promise<Record<string, unknown>> {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} must be an object.`);
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Could not read ${file}. Check that it contains a valid JSON object.`);
  }
}

/** Display only known noncredential Notion settings, including nested filter values. */
function safeSettings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeSettings);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/token|secret|password|authorization|api.?key/i.test(key))
    .map(([key, item]) => [key, safeSettings(item)]));
  return value;
}

export class DashboardState {
  private tracked: QueuedJob[] = [];
  private removed = new Set<string>();
  private responses: Record<string, AnswerBank> = {};
  private tracking: Record<string, { status?: string; lifecycle?: string }> = {};
  private manual: QueuedJob[] = [];
  private tasks: Task[] = [];
  private writes = Promise.resolve();
  private refreshing?: Promise<void>;
  private working = false;
  private worker?: Promise<void>;
  private paused = true;
  private advance = true;
  private autofill = { ...defaultAutofillSettings };
  private concurrency = 1;
  private workerError?: string;
  private notion: Source<QueuedJob[]> = { data: [] };
  private file: Source<QueuedJob[]> = { data: [] };
  private answers: Source<AnswerSnapshot | null> = { data: null };
  private config: Source<Record<string, unknown>> = { data: {} };

  constructor(private processJob: Processor, private statePath = 'output/dashboard-state.json') {}

  async init() {
    this.autofill = await loadAutofillSettings();
    try {
      const saved: Persisted = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.manual) || !Array.isArray(saved.tasks) || typeof saved.advance !== 'boolean') throw new Error('Invalid dashboard queue file.');
      for (const job of [...saved.manual, ...saved.tasks.map(task => task.job)]) jobKey(job.url);
      this.manual = saved.manual;
      this.tracked = saved.tracked ?? [];
      this.removed = new Set(saved.removed ?? []);
      this.responses = saved.responses ?? {};
      this.tracking = saved.tracking ?? {};
      this.advance = saved.advance;
      if (saved.concurrency !== undefined) this.concurrency = validateConcurrency(saved.concurrency);
      if (saved.autofill) this.autofill = validateAutofillSettings(saved.autofill);
      this.tasks = saved.tasks.map(task => task.state === 'running'
        ? { ...task, state: 'interrupted', message: 'Dashboard stopped during autofill. Review the browser, then retry.', updatedAt: now() } : task);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Restarting a dashboard never silently starts pending browser work.
    await this.save();
    await this.refresh();
  }

  private save() {
    const body = JSON.stringify({ version: 1, manual: this.manual, tasks: this.tasks, advance: this.advance, autofill: this.autofill, concurrency: this.concurrency, tracked: this.tracked, removed: [...this.removed], responses: this.responses, tracking: this.tracking }, null, 2);
    const write = this.writes.then(async () => {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      await fs.writeFile(`${this.statePath}.tmp`, body, { mode: 0o600 });
      await fs.rename(`${this.statePath}.tmp`, this.statePath);
    });
    this.writes = write.catch(() => {});
    return write;
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshSources().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async refreshSources() {
    const update = async <T>(source: Source<T>, read: () => Promise<T>) => {
      try { source.data = await read(); source.fetchedAt = now(); delete source.error; }
      catch (error) { source.error = message(error); }
    };
    await Promise.all([
      update(this.file, () => loadJobQueue(new Set(['--source=file']))),
      update(this.notion, async () => {
        const config = await optionalJSON('config/notion.json') as unknown as NotionConfig;
        if (!config.databaseId && !config.dataSourceId) return [];
        // The pipeline and runnable selection are different sets. GPT Web may
        // move a page out of the selection; its tracking still needs refreshing.
        const catalog = await loadNotionJobs({ ...config, filter: undefined }, config.token);
        const eligible = config.filter ? await loadNotionJobs(config, config.token) : catalog;
        // Commit only after BOTH reads succeed; never publish a partial snapshot.
        const known = new Map(this.tracked.map(job => [jobKey(job.url), job]));
        for (const job of catalog) known.set(jobKey(job.url), job);
        this.tracked = [...known.values()];
        return eligible;
      }),
      update(this.answers, loadAnswerSnapshot),
      update(this.config, async () => {
        const [profile, notion] = await Promise.all([optionalJSON('config/profile.json'), optionalJSON('config/notion.json')]);
        const keys = ['databaseId', 'dataSourceId', 'urlProperty', 'titleProperty', 'companyProperty', 'statusProperty', 'lifecycleProperty', 'filter', 'sorts', 'answerBank'];
        return { profile, account: authSummary(await loadAuthSettings()), notion: safeSettings(Object.fromEntries(keys.filter(key => key in notion).map(key => [key, notion[key]]))),
          notionTokenConfigured: typeof notion.token === 'string' && !!notion.token.trim() };
      })
    ]);
    this.notion.data.sort(alphabetical);
    if (!this.notion.error) {
      const known = new Map(this.tracked.map(job => [jobKey(job.url), job]));
      for (const job of this.notion.data) known.set(jobKey(job.url), job);
      this.tracked = [...known.values()];
      await this.save();
    }
  }

  async view() {
    const results = await loadResults();
    const jobs = new Map<string, QueuedJob & { sources: string[] }>();
    const add = (job: QueuedJob, source: string) => {
      const key = jobKey(job.url), previous = jobs.get(key);
      jobs.set(key, { ...previous, ...job, notion: job.notion ?? previous?.notion,
        sources: [...new Set([...(previous?.sources ?? []), source])] });
    };
    for (const result of results.values()) add(result, 'History');
    for (const task of this.tasks) add(task.job, 'Dashboard');
    for (const job of this.manual) add(job, 'Manual');
    for (const job of this.file.data) add(job, 'File');
    // Refreshed tracking wins over old Notion metadata attached to a pasted URL.
    for (const job of this.tracked) add(job, 'Notion');
    for (const job of this.notion.data) add(job, 'Notion');
    const allResults = [...results.values()];
    return {
      applications: [...jobs].map(([key, job]) => {
        const result = results.get(key) ?? allResults.find(r => jobKey(r.url) === key);
        const task = this.tasks.find(t => jobKey(t.job.url) === key);
        const blocked = this.protectedResult(job, allResults);
        const noLongerSelected = job.notion && this.notion.fetchedAt && !this.notion.error &&
          !this.notion.data.some(current => current.notion?.pageId === job.notion?.pageId && jobKey(current.url) === key);
        const tracking = job.notion ? { status: job.notion.status, lifecycle: job.notion.lifecycle,
          statusOptions: job.notion.statusOptions ?? [], lifecycleOptions: job.notion.lifecycleOptions ?? [] }
          : { ...this.tracking[key], statusOptions: ['New', 'Apply', 'Applied', 'Rejected', 'Closed'], lifecycleOptions: ['Active', 'Archived'] };
        const finished = ['Applied', 'Rejected', 'Closed'].includes(tracking.status ?? '') || tracking.lifecycle === 'Archived';
        return { ...job, url: key, result, task, tracking, removed: this.removed.has(key),
          questions: applicationQuestions(result, (this.config.data.profile ?? {}) as Profile, this.answers.data?.effective ?? {}),
          retryBlocked: !!blocked || !!noLongerSelected || finished || this.removed.has(key),
          blockedReason: blocked?.status ?? (this.removed.has(key) ? 'Removed from dashboard' : finished ? tracking.lifecycle === 'Archived' ? 'Archived' : tracking.status : noLongerSelected ? 'Not in current Notion selection' : undefined) };
      }).sort(alphabetical),
      worker: { paused: this.paused, current: this.tasks.find(t => t.state === 'running')?.job.url,
        active: this.tasks.filter(t => t.state === 'running').map(t => t.job.url), concurrency: this.concurrency, running: this.working, error: this.workerError,
        autofill: this.autofill, queued: this.tasks.filter(t => t.state === 'queued').length, advance: this.advance },
      notion: this.notion, file: this.file, answers: this.answers, config: this.config,
      observedAt: now()
    };
  }

  private protectedResult(job: QueuedJob, results: JobResult[]) {
    const key = jobKey(job.url);
    // Preserve protection across alternate board URLs and resolved employer URLs.
    const linked = results.find(r => jobKey(r.url) === key);
    const resolved = linked?.resolvedUrl ? jobKey(linked.resolvedUrl) : key;
    return results.find(r => ['submitted', 'needs_verification'].includes(r.status) &&
      (jobKey(r.url) === key || jobKey(r.url) === resolved || (r.resolvedUrl && [key, resolved].includes(jobKey(r.resolvedUrl)))));
  }

  async addUrls(input: unknown) {
    this.assertQueueEditable();
    if (typeof input !== 'string') throw new Error('Paste one or more HTTP(S) URLs.');
    const urls = input.split(/\s+/).filter(Boolean);
    if (!urls.length || urls.length > 500) throw new Error('Add between 1 and 500 URLs at a time.');
    const known = (await this.view()).applications;
    const jobs: QueuedJob[] = urls.map(url => {
      const key = jobKey(url), existing = known.find(job => job.url === key);
      // Pasting a known Notion link must not bypass live source revalidation.
      return { url: key, ...(existing?.notion ? { notion: existing.notion } : {}) };
    }); // Validate entire batch before modifying it.
    for (const job of jobs) this.removed.delete(jobKey(job.url));
    let added = 0;
    for (const job of jobs) if (!this.manual.some(existing => jobKey(existing.url) === job.url)) {
      this.manual.push(job); added++;
    }
    const result = await this.enqueue(jobs);
    return { added, ...result };
  }

  private async enqueue(jobs: QueuedJob[]) {
    const results = [...(await loadResults()).values()];
    const view = await this.view();
    let queued = 0, skipped = 0;
    for (const job of jobs) {
      const key = jobKey(job.url), existing = this.tasks.find(t => jobKey(t.job.url) === key);
      if (view.applications.find(item => item.url === key)?.retryBlocked || this.protectedResult(job, results) || (existing && ['queued', 'running'].includes(existing.state))) { skipped++; continue; }
      const task: Task = { job: { ...job, url: key }, state: 'queued', updatedAt: now() };
      if (existing) this.tasks[this.tasks.indexOf(existing)] = task;
      else this.tasks.push(task);
      queued++;
    }
    await this.save();
    return { queued, skipped };
  }

  async retry(url?: unknown) {
    this.assertQueueEditable();
    const view = await this.view();
    const jobs = url === undefined ? view.applications : view.applications.filter(job => job.url === jobKey(String(url)));
    if (url !== undefined && !jobs.length) throw new Error('Application is not tracked. Add its URL first.');
    const eligible = jobs.filter(job => !job.retryBlocked);
    const result = await this.enqueue(eligible.map(({ url, notion }) => ({ url, notion })));
    result.skipped += jobs.length - eligible.length;
    return result;
  }

  private assertQueueEditable() {
    if (this.working) throw new Error('Pause and wait for active applications before editing the queue.');
  }

  async select(urls: unknown, selected: unknown) {
    this.assertQueueEditable();
    if (!Array.isArray(urls) || !urls.length || urls.length > 500 || urls.some(url => typeof url !== 'string') || typeof selected !== 'boolean') {
      throw new Error('Choose applications and whether to include them in the queue.');
    }
    const keys = urls.map(url => jobKey(url));
    const jobs = (await this.view()).applications.filter(job => keys.includes(job.url));
    if (jobs.length !== new Set(keys).size) throw new Error('One of these applications is no longer tracked. Refresh the list.');
    if (selected) {
      if (jobs.some(job => job.retryBlocked)) throw new Error('One of these applications is protected or no longer eligible. Review its row.');
      return this.enqueue(jobs.map(({ url, notion }) => ({ url, notion })));
    }
    this.tasks = this.tasks.filter(task => task.state !== 'queued' || !keys.includes(jobKey(task.job.url)));
    await this.save();
    return { message: `${jobs.length} application(s) removed from the queue.` };
  }

  async remove(url: string, restore = false) {
    this.assertQueueEditable();
    const key = jobKey(url);
    if (!(await this.view()).applications.some(job => job.url === key)) throw new Error('Application is not tracked.');
    if (restore) this.removed.delete(key);
    else {
      this.removed.add(key);
      this.tasks = this.tasks.filter(task => jobKey(task.job.url) !== key);
      delete this.responses[key];
    }
    await this.save();
    return { message: restore ? 'Application restored. Select it to include it in the queue.' : 'Removed from the dashboard and queue. The Notion record is unchanged.' };
  }

  async updateTracking(url: string, field: unknown, value: unknown, expected?: unknown) {
    this.assertQueueEditable();
    if (!['status', 'lifecycle'].includes(String(field)) || typeof value !== 'string') throw new Error('Choose a tracking field and value.');
    const job = (await this.view()).applications.find(job => job.url === jobKey(url));
    if (!job || job.removed) throw new Error('Application is not tracked.');
    const target = field as 'status' | 'lifecycle';
    if (expected !== undefined && expected !== (job.tracking[target] ?? '')) throw new Error('Tracking changed since you opened this row. Refresh and choose again.');
    if (!job.tracking[target === 'status' ? 'statusOptions' : 'lifecycleOptions'].includes(value)) throw new Error('Choose an available tracking option.');
    if (job.notion) {
      const config = await optionalJSON('config/notion.json') as unknown as NotionConfig;
      let updated: QueuedJob;
      try { updated = await updateNotionJob(config, job, target, value); }
      catch (error) { await this.refresh(); throw error; }
      this.tracked = [...this.tracked.filter(item => jobKey(item.url) !== job.url), updated];
      for (const list of [this.notion.data, this.manual]) {
        for (let i = 0; i < list.length; i++) if (jobKey(list[i].url) === job.url) list[i] = updated;
      }
      for (const task of this.tasks) if (jobKey(task.job.url) === job.url) task.job = updated;
    } else this.tracking[job.url] = { ...this.tracking[job.url], [target]: value };
    // A tracking edit always removes pending work; the user can explicitly reselect it.
    this.tasks = this.tasks.filter(task => task.state !== 'queued' || jobKey(task.job.url) !== job.url);
    await this.save();
    if (job.notion) await this.refresh();
    return { message: job.notion ? 'Saved and verified in Notion.' : 'Tracking status saved locally.' };
  }

  async answer(url: string, inputs: unknown) {
    this.assertQueueEditable();
    await this.refresh();
    if (this.answers.error || this.config.error) throw new Error('Refresh the Answer Bank and configuration before saving answers.');
    const job = (await this.view()).applications.find(job => job.url === jobKey(url));
    if (!job || job.retryBlocked) throw new Error('This application is no longer eligible. Review its tracking status.');
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 100) throw new Error('Enter at least one answer.');
    const answers: AnswerBank = {};
    for (const input of inputs) {
      const question = job.questions.find(field => field.index === input?.index);
      if (!question?.canAnswer || input.label !== question.label || input.resultTimestamp !== job.result?.timestamp ||
          typeof input.value !== 'string' || !input.value.trim() || input.value.length > 20000) {
        throw new Error('The unanswered questions changed or cannot be answered here. Refresh this row before retrying.');
      }
      if (question.options?.length) {
        const values = question.type === 'select-multiple' || question.type === 'checkbox' ? (() => { try { return JSON.parse(input.value); } catch { return [input.value]; } })() : [input.value];
        if (!Array.isArray(values) || !values.length || values.some(value => !question.options!.includes(value))) throw new Error('Choose the exact employer options shown for this question.');
      }
      answers[question.label] = input.value.trim();
    }
    this.responses[job.url] = { ...this.responses[job.url], ...answers };
    const result = await this.enqueue([{ url: job.url, notion: job.notion }]);
    return { ...result, message: 'Answers saved for this application. Retry added to the queue; use Run queue when ready.' };
  }

  async start() {
    if (this.working) return;
    if (!this.tasks.some(task => task.state === 'queued')) throw new Error('Select at least one application before starting.');
    this.tasks.sort((a, b) => alphabetical(a.job, b.job));
    this.paused = false;
    delete this.workerError;
    await this.save();
    this.kick();
  }
  async pause() { this.paused = true; await this.save(); }
  async waitForIdle() { await this.worker; }
  async settings(advance: unknown, autofill?: unknown, concurrency?: unknown) {
    if (advance !== undefined && typeof advance !== 'boolean') throw new Error('advance must be a boolean.');
    if (this.working) throw new Error('Pause and wait for the current application before changing settings.');
    const validated = autofill === undefined ? this.autofill : validateAutofillSettings(autofill);
    const slots = concurrency === undefined ? this.concurrency : validateConcurrency(concurrency);
    if (advance !== undefined) this.advance = advance as boolean;
    this.autofill = validated; this.concurrency = slots; await this.save();
  }

  async accountSettings(input: unknown) {
    if (this.working) throw new Error('Pause and wait for the current applications before changing account settings.');
    const account = await saveAuthSettings(input);
    this.config.data = { ...this.config.data, account };
  }

  private kick() {
    if (this.working || this.paused) return;
    this.working = true;
    this.worker = this.drain().catch(error => { this.workerError = message(error); this.paused = true; })
      .finally(() => {
        this.working = false;
        if (!this.paused && this.tasks.some(t => t.state === 'queued')) this.kick();
        else if (!this.tasks.some(t => t.state === 'queued')) this.paused = true;
      });
  }

  private async drain() {
    const self = this;
    async function* claimTasks() {
      while (!self.paused) {
        const task = self.tasks.find(t => t.state === 'queued');
        if (!task) return;
        // Synchronous claim before any await: no other slot can take this task.
        task.state = 'running'; task.updatedAt = now();
        await self.save();
        try {
          // Revalidate Notion serially before EVERY new task, never from a stale snapshot.
          if (task.job.notion) {
            try { self.notion.data = (await loadJobQueue(new Set(['--source=notion']))).sort(alphabetical); self.notion.fetchedAt = now(); delete self.notion.error; }
            catch (error) { self.notion.error = message(error); throw error; }
            if (!self.notion.data.some(job => job.notion?.pageId === task.job.notion?.pageId && jobKey(job.url) === task.job.url)) {
              throw new Error('This Notion job was removed, changed, or no longer matches the filter. Refresh sources and queue its current URL.');
            }
          }
          const current = (await self.view()).applications.find(job => job.url === jobKey(task.job.url));
          if (!current || current.retryBlocked) throw new Error(current?.blockedReason ?? 'Application is no longer eligible.');
          if (self.protectedResult(task.job, [...(await loadResults()).values()])) throw new Error('Already submitted or awaiting submission verification; review the existing result.');
        } catch (error) {
          task.state = 'error'; task.message = message(error); task.updatedAt = now();
          self.workerError = task.message; self.paused = true; await self.save(); return;
        }
        if (self.paused) { task.state = 'queued'; task.updatedAt = now(); await self.save(); return; }
        yield task;
      }
    }
    await runConcurrent(claimTasks(), this.concurrency, async task => {
      try {
        const result = await this.processJob(task.job, this.advance, (profile, answers) => {
          this.answers = { data: answers, fetchedAt: answers.fetchedAt };
          this.config.data = { ...this.config.data, profile };
        }, { ...this.autofill }, this.responses[jobKey(task.job.url)]);
        task.state = result?.status === 'error' ? 'error' : 'done';
        task.message = result?.message ?? 'Skipped by the runner; inspect the existing result.';
      } catch (error) {
        task.state = 'error'; task.message = message(error);
        // Stop claiming new work. Already active tabs finish and persist results.
        this.workerError = task.message; this.paused = true;
      }
      task.updatedAt = now();
      await this.save();
    });
  }
}
