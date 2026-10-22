import { jobKey } from './detect.js';
import { normalize } from './answers.js';
import type { AnswerBank, QueuedJob } from './types.js';

export interface NotionConfig {
  /** Local credential; never included in jobs or results. */
  token?: string;
  databaseId?: string;
  dataSourceId?: string;
  urlProperty: string;
  /** Optional read-only source for approved application answers. */
  answerBank?: { dataSourceId: string };
  titleProperty?: string;
  companyProperty?: string;
  statusProperty?: string;
  lifecycleProperty?: string;
  /** Native Notion query filter/sorts, evaluated on the server. */
  filter?: Record<string, unknown>;
  sorts?: Record<string, unknown>[];
}

type ObjectValue = Record<string, any>;
type Dependencies = {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  warn?: (message: string) => void;
};

function notionId(value: string): string {
  const id = value.replace(/-/g, '');
  if (!/^[a-f0-9]{32}$/i.test(id)) throw new Error('Notion IDs must be database/data source UUIDs, not view URLs.');
  return id;
}

function propertyText(property: ObjectValue | undefined): string {
  if (!property) return '';
  if (property.type === 'url') return property.url ?? '';
  if (property.type === 'title' || property.type === 'rich_text') {
    return (property[property.type] ?? []).map((part: ObjectValue) => part.plain_text ?? part.text?.content ?? '').join('');
  }
  if (property.type === 'formula' && property.formula?.type === 'string') return property.formula.string ?? '';
  return '';
}

function notionClient(token: string, dependencies: Dependencies = {}) {
  const request = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  return async function api(route: string, body?: ObjectValue, method = body ? 'POST' : 'GET'): Promise<ObjectValue> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await request(`https://api.notion.com/v1/${route}`, {
          method,
          headers: { Authorization: `Bearer ${token!.trim()}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(30000), redirect: 'error'
        });
      } catch {
        throw new Error('Notion request failed or timed out. Check connectivity and retry.');
      }
      if (response.ok) return await response.json() as ObjectValue;
      if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await response.body?.cancel();
        if (retryAfter > 60) throw new Error('Notion is rate limited. Retry after the server cooldown.');
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
        continue;
      }
      await response.body?.cancel();
      const hint = response.status === 401 ? 'Check token in config/notion.json.'
        : response.status === 403 && method === 'PATCH' ? 'Allow update-content access for your Notion integration and share the job database with it.'
        : [403, 404].includes(response.status) ? 'Check the ID and share the database with your integration.'
        : response.status === 400 ? 'Check property names, filter types, and sorts in config/notion.json.' : 'Retry later.';
      throw new Error(`Notion API returned HTTP ${response.status}. ${hint}`);
    }
  };
}

/** Read the configured eligible job selection. */
export async function loadNotionJobs(config: NotionConfig, token: string | undefined, dependencies: Dependencies = {}): Promise<QueuedJob[]> {
  if (typeof token !== 'string' || !token.trim()) throw new Error('Set token in config/notion.json to your Notion integration token and share the database with that integration.');
  if (!config || typeof config !== 'object' || typeof config.urlProperty !== 'string' || !config.urlProperty.trim()) {
    throw new Error('config/notion.json must specify urlProperty.');
  }
  if (!config.dataSourceId && !config.databaseId) throw new Error('Set databaseId or dataSourceId in config/notion.json.');
  const api = notionClient(token, dependencies);
  const warn = dependencies.warn ?? console.warn;
  let dataSourceId = config.dataSourceId ? notionId(config.dataSourceId) : undefined;
  if (!dataSourceId) {
    const database = await api(`databases/${notionId(config.databaseId!)}`);
    if (!Array.isArray(database.data_sources) || database.data_sources.length !== 1) {
      throw new Error('Database has zero or multiple data sources. Configure dataSourceId in config/notion.json explicitly.');
    }
    dataSourceId = notionId(database.data_sources[0].id);
  }
  // Validate the mapping even for an empty database; never guess between URL properties.
  const schema = await api(`data_sources/${dataSourceId}`);
  const urlSchema = schema.properties?.[config.urlProperty];
  if (!urlSchema || !['url', 'rich_text', 'formula'].includes(urlSchema.type)) {
    throw new Error(`Notion URL property "${config.urlProperty}" must exist and be URL, rich text, or a string formula.`);
  }
  for (const key of [config.titleProperty, config.companyProperty].filter(Boolean) as string[]) {
    if (!schema.properties?.[key]) throw new Error(`Notion property "${key}" does not exist. Check config/notion.json.`);
  }
  const jobs: QueuedJob[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await api(`data_sources/${dataSourceId}/query`, {
      page_size: 100, ...(config.filter ? { filter: config.filter } : {}),
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' },
        { timestamp: 'created_time', direction: 'descending' },
        ...(config.sorts ?? []).filter(sort => !['last_edited_time', 'created_time'].includes(String(sort.timestamp)))], ...(cursor ? { start_cursor: cursor } : {})
    });
    if (!Array.isArray(response.results)) throw new Error('Notion query returned an invalid results list.');
    for (const page of response.results) {
      if (page.object !== 'page' || page.archived || page.in_trash || page.is_archived) continue;
      const raw = propertyText(page.properties?.[config.urlProperty]).trim();
      let key: string;
      try { key = jobKey(raw); } catch { warn(`Notion record ${page.id}: skipped missing or invalid job URL.`); continue; }
      if (seen.has(key)) continue;
      seen.add(key);
      const title = config.titleProperty ? page.properties?.[config.titleProperty]
        : Object.values(page.properties ?? {}).find((p: any) => p.type === 'title') as ObjectValue | undefined;
      jobs.push({ url: raw, notion: { pageId: page.id, pageUrl: page.url,
        lastEditedTime: page.last_edited_time, title: propertyText(!config.titleProperty && schema.properties?.Title ? page.properties?.Title : title) || propertyText(title), company: propertyText(page.properties?.[config.companyProperty ?? 'Company']) || undefined,
        ...jobTrackingMetadata(page, schema, config) } });
    }
    if (!response.has_more) break;
    cursor = response.next_cursor;
    if (!cursor || cursors.has(cursor)) throw new Error('Notion pagination did not advance; no partial queue will be used.');
    cursors.add(cursor);
  } while (true);
  return jobs;
}

/** Only confirmed literal answers are reusable without application-specific checks. */
export async function loadNotionAnswers(
  config: { dataSourceId: string }, token: string | undefined, dependencies: Dependencies = {}
): Promise<AnswerBank> {
  if (typeof token !== 'string' || !token.trim()) throw new Error('Set token in config/notion.json to read the Answer Bank.');
  const api = notionClient(token, dependencies);
  const id = notionId(config.dataSourceId);
  const schema = await api(`data_sources/${id}`);
  for (const [name, types] of Object.entries({
    Question: ['title'], 'Canonical Answer': ['rich_text'], 'Auto-fill OK': ['checkbox'], Status: ['select', 'status']
  })) {
    if (!types.includes(schema.properties?.[name]?.type)) throw new Error(`Notion Answer Bank property "${name}" is missing or has an unsupported type.`);
  }
  const bank: AnswerBank = Object.create(null);
  const seen = new Map<string, string>();
  const conflicts = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await api(`data_sources/${id}/query`, {
      page_size: 100,
      filter: { and: [
        { property: 'Auto-fill OK', checkbox: { equals: true } },
        { property: 'Status', [schema.properties.Status.type]: { equals: 'Confirmed' } }
      ] },
      ...(cursor ? { start_cursor: cursor } : {})
    });
    if (!Array.isArray(response.results)) throw new Error('Notion Answer Bank query returned an invalid results list.');
    for (const page of response.results) {
      if (page.object !== 'page' || page.archived || page.in_trash || page.is_archived) continue;
      const props = page.properties ?? {};
      const status = props.Status?.[props.Status?.type]?.name;
      // Recheck locally too; a checkbox alone does not approve an unconfirmed answer.
      if (status !== 'Confirmed' || props['Auto-fill OK']?.checkbox !== true) continue;
      const question = propertyText(props.Question).trim();
      const answer = propertyText(props['Canonical Answer']).trim();
      const key = normalize(question);
      if (!key || !answer || /^(YOUR_|REPLACE_WITH_|CUSTOMIZE\b|skip$|dynamic$|custom$)/i.test(answer)) continue;
      const previous = seen.get(key);
      if (previous !== undefined && bank[previous] !== answer) conflicts.add(key);
      if (previous === undefined) { seen.set(key, question); bank[question] = answer; }
    }
    if (!response.has_more) break;
    cursor = response.next_cursor;
    if (!cursor || cursors.has(cursor)) throw new Error('Notion Answer Bank pagination did not advance; no partial answers will be used.');
    cursors.add(cursor);
  } while (true);
  for (const key of conflicts) delete bank[seen.get(key)!];
  return bank;
}

function jobTrackingMetadata(page: ObjectValue, schema: ObjectValue, config: NotionConfig) {
  const read = (name: string) => {
    const type = schema.properties?.[name]?.type;
    return ['select', 'status'].includes(type) ? {
      value: page.properties?.[name]?.[type]?.name,
      options: (schema.properties[name][type]?.options ?? []).map((option: ObjectValue) => option.name as string)
    } : undefined;
  };
  const status = read(config.statusProperty ?? 'Status');
  const lifecycle = read(config.lifecycleProperty ?? 'Lifecycle');
  return { status: status?.value, statusOptions: status?.options,
    lifecycle: lifecycle?.value, lifecycleOptions: lifecycle?.options };
}

/** Explicit user tracking edits only; autofill never calls this writer. */
export async function updateNotionJob(
  config: NotionConfig, job: QueuedJob, field: 'status' | 'lifecycle', value: string, dependencies: Dependencies = {}
): Promise<QueuedJob> {
  if (!config.token?.trim()) throw new Error('Configure a Notion token before saving tracking changes.');
  if (!job.notion) throw new Error('This application is not linked to Notion.');
  const api = notionClient(config.token, dependencies);
  let source = config.dataSourceId;
  if (!source) {
    const database = await api(`databases/${notionId(config.databaseId ?? '')}`);
    if (database.data_sources?.length !== 1) throw new Error('Configure one explicit Notion data source before updating a job.');
    source = database.data_sources[0].id;
  }
  const schema = await api(`data_sources/${notionId(source!)}`);
  const route = `pages/${notionId(job.notion.pageId)}`;
  const current = await api(route);
  if (current.archived || current.in_trash || current.is_archived ||
      notionId(current.parent?.data_source_id ?? '') !== notionId(source!)) {
    throw new Error('This record is no longer in the configured Notion data source. Refresh before editing.');
  }
  if (jobKey(propertyText(current.properties?.[config.urlProperty])) !== jobKey(job.url)) {
    throw new Error('The Notion application URL changed. Refresh before editing its status.');
  }
  const property = field === 'status' ? config.statusProperty ?? 'Status' : config.lifecycleProperty ?? 'Lifecycle';
  const type = schema.properties?.[property]?.type;
  const options = schema.properties?.[property]?.[type]?.options;
  if (!['select', 'status'].includes(type) || !options?.some((option: ObjectValue) => option.name === value)) {
    throw new Error(`Choose an existing Notion ${property} option. No new options will be created.`);
  }
  const previous = job.notion[field] ?? '';
  const live = current.properties?.[property]?.[type]?.name ?? '';
  if (live !== previous) {
    throw new Error('This tracking value changed in Notion since your last sync. Refresh and choose again; the newer value was not overwritten.');
  }
  await api(route, { properties: { [property]: { [type]: { name: value } } } }, 'PATCH');
  let saved: ObjectValue;
  try { saved = await api(route); }
  catch { throw new Error('Notion may have saved the change, but verification failed. Refresh and check its current status before retrying.'); }
  if (saved.properties?.[property]?.[type]?.name !== value) {
    throw new Error('Notion did not confirm this change. Refresh the application before retrying.');
  }
  return { url: job.url, notion: { ...job.notion, ...jobTrackingMetadata(saved, schema, config), lastEditedTime: saved.last_edited_time } };
}
