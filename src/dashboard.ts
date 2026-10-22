import { checkLMStudio } from './local-resolver.js';
import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { chromium, type BrowserContext } from 'playwright';
import { DashboardState } from './dashboard-state.js';
import { dashboardHTML, dashboardCSS, dashboardJS, themeJS } from './dashboard-ui.js';
import { runJobs } from './run.js';
import type { JobResult } from './types.js';

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json.');
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 128_000) throw new Error('Request is too large.');
  }
  const value = JSON.parse(body || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value;
}

export function createDashboardServer(state: DashboardState) {
  const csrf = randomBytes(32).toString('hex');
  let mutations = Promise.resolve();
  return createServer(async (request, response) => {
    const send = (status: number, value: unknown, type = 'application/json') => {
      response.writeHead(status, {
        'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
      });
      response.end(type === 'application/json' ? JSON.stringify(value) : String(value));
    };
    try {
      const address = response.socket?.localAddress;
      const port = response.socket?.localPort;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(address ?? '') || !allowedHosts.includes(request.headers.host ?? '')) {
        send(403, { error: 'Use the local dashboard address.' }); return;
      }
      const pathname = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname;
      if (request.method === 'GET') {
        if (pathname === '/') send(200, dashboardHTML(csrf), 'text/html');
        else if (pathname === '/dashboard.css') send(200, dashboardCSS, 'text/css');
        else if (pathname === '/theme.js') send(200, themeJS, 'text/javascript');
        else if (pathname === '/dashboard.js') send(200, dashboardJS, 'text/javascript');
        else if (pathname === '/api/state') send(200, await state.view());
        else if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); }
        else send(404, { error: 'Not found.' });
        return;
      }
      if (request.method !== 'POST') { send(405, { error: 'Method not allowed.' }); return; }
      const token = request.headers['x-formwright-token'];
      if (typeof token !== 'string' || token.length !== csrf.length || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf)) ||
        (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`)) {
        send(403, { error: 'Reload this local dashboard before using its controls.' }); return;
      }
      const body = await readBody(request);
      // Keep commands ordered when two tabs/buttons act at the same time.
      const operation = mutations.then(async () => {
        if (pathname === '/api/refresh') { await state.refresh(); return { message: 'Sources refreshed. Check each source for errors.' }; }
        if (pathname === '/api/add') return state.addUrls(body.urls);
        if (pathname === '/api/retry') {
          if (typeof body.url !== 'string') throw new Error('Choose an application URL.');
          return state.retry(body.url);
        }
        if (pathname === '/api/selection') return state.select(body.urls, body.selected);
        if (['/api/remove', '/api/restore', '/api/tracking', '/api/answers'].includes(pathname)) {
          if (typeof body.url !== 'string') throw new Error('Choose an application URL.');
          if (pathname === '/api/remove') return state.remove(body.url);
          if (pathname === '/api/restore') return state.remove(body.url, true);
          if (pathname === '/api/tracking') return state.updateTracking(body.url, body.field, body.value, body.expected);
          return state.answer(body.url, body.answers);
        }
        if (pathname === '/api/retry-all') return state.retry();
        if (pathname === '/api/start') { await state.start(); return { message: 'Queue started.' }; }
        if (pathname === '/api/pause') { await state.pause(); return { message: 'Paused. Active applications can finish.' }; }
        if (pathname === '/api/lmstudio/check') return checkLMStudio(body.autofill as import('./autofill-settings.js').AutofillSettings);
        if (pathname === '/api/account') { await state.accountSettings(body); return { message: 'Account settings saved. Password stays hidden.' }; }
        if (pathname === '/api/settings') { await state.settings(body.advance, body.autofill, body.concurrency); return { message: 'Autofill settings saved.' }; }
        throw new Error('Unknown command.');
      });
      mutations = operation.then(() => {}, () => {});
      send(200, await operation);
    } catch (error) {
      if (!response.headersSent) send(400, { error: error instanceof Error ? error.message : 'Dashboard request failed.' });
      else response.end();
    }
  });
}

async function acquireLock() {
  const file = 'output/dashboard.lock';
  await fs.mkdir('output', { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); }
      return async () => { await fs.unlink(file).catch(() => {}); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await fs.readFile(file, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') { await fs.unlink(file); continue; }
        }
      }
      throw new Error('Another dashboard owns this queue. Stop it first. If no dashboard is running, remove output/dashboard.lock.');
    }
  }
  throw new Error('Could not acquire the dashboard queue lock. Retry startup.');
}

export async function startDashboard(port = 4318) {
  const releaseLock = await acquireLock();
  let context: BrowserContext | undefined;
  let opening: Promise<BrowserContext> | undefined;
  const state = new DashboardState(async (job, advance, onInputs, autofill, applicationAnswers) => {
    // Preflight uses the runner's current files/Notion reads. The browser is shared across jobs.
    if (!context && !opening) {
      opening = chromium.launchPersistentContext(path.resolve('.browser'), {
        headless: false, viewport: { width: 1366, height: 900 }, acceptDownloads: false
      }).then(created => {
        context = created;
        created.once('close', () => { if (context === created) context = undefined; });
        return created;
      }).finally(() => { opening = undefined; });
    }
    const active = context ?? await opening!;
    let result: JobResult | undefined;
    await runJobs(new Set(['--visible', ...(advance ? ['--advance'] : [])]), {
      context: active, autofill, applicationAnswers, jobs: [job], waitForReview: false, onResult: value => { result = value; }, onInputs
    });
    return result;
  });
  const server = createDashboardServer(state);
  try {
    await state.init();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) { await releaseLock(); throw error; }
  const address = server.address();
  console.log(`Formwright dashboard: http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`);
  console.log('Local only. Autofill never submits. Close another Formwright browser run before starting this queue.');
  const shutdown = async () => {
    process.off('SIGINT', signalShutdown);
    process.off('SIGTERM', signalShutdown);
    await state.pause();
    server.close();
    if (opening) await opening.catch(() => {});
    await context?.close();
    await state.waitForIdle();
    await releaseLock();
  };
  const signalShutdown = () => { void shutdown().catch(error => { console.error(error.message); process.exitCode = 1; }); };
  process.once('SIGINT', signalShutdown);
  process.once('SIGTERM', signalShutdown);
  return { server, state, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const portArg = process.argv.slice(2).find(arg => arg.startsWith('--port='));
  const port = portArg ? Number(portArg.slice(7)) : 4318;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be an integer from 1 to 65535.');
  startDashboard(port).catch(error => { console.error(error.message); process.exitCode = 1; });
}
