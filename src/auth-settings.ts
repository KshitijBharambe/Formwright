import { promises as fs } from 'node:fs';

export interface AuthSettings {
  enabled: boolean;
  allowSignup: boolean;
  username: string;
  password: string;
  /** Exact hostnames; *.example.com includes subdomains only. */
  allowedHosts: string[];
}
const file = 'config/credentials.json';
export const defaultAuthSettings: AuthSettings = { enabled: false, allowSignup: false, username: '', password: '', allowedHosts: [] };
export function validateAuthSettings(input: unknown): AuthSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Account settings must be an object.');
  const value = { ...defaultAuthSettings, ...input };
  if (typeof value.enabled !== 'boolean' || typeof value.allowSignup !== 'boolean' ||
    typeof value.username !== 'string' || typeof value.password !== 'string') throw new Error('Invalid account settings.');
  if (!Array.isArray(value.allowedHosts) || value.allowedHosts.some(host => typeof host !== 'string' ||
    !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(host))) {
    throw new Error('Use exact hostnames or *.example.com in allowedHosts, without URLs or paths.');
  }
  if (value.enabled && (!value.username.trim() || !value.password || !value.allowedHosts.length)) {
    throw new Error('Automatic login needs a username, password and at least one allowed hostname.');
  }
  return { enabled: value.enabled, allowSignup: value.allowSignup, username: value.username.trim(), password: value.password,
    allowedHosts: [...new Set(value.allowedHosts.map(host => host.toLowerCase()))] };
}
export async function loadAuthSettings(): Promise<AuthSettings> {
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaultAuthSettings, allowedHosts: [] };
    throw new Error('Could not read config/credentials.json. Check its JSON syntax.');
  }
  return validateAuthSettings(value);
}
export function authSummary(settings: AuthSettings) {
  const status = !settings.username || !settings.password ? 'missing_credentials' : settings.enabled ? 'enabled' : 'disabled';
  const message = status === 'missing_credentials'
    ? 'No shared login credentials are saved. Open Configuration → Shared website account, save your account email and password, allow the login hostname, and enable automatic sign-in, then retry.'
    : status === 'disabled'
      ? 'Automatic sign-in is disabled. Enable it in Configuration → Shared website account, then retry.'
      : 'Automatic sign-in is enabled for the allowed login hostnames.';
  return { status, message, enabled: settings.enabled, allowSignup: settings.allowSignup, username: settings.username,
    allowedHosts: settings.allowedHosts, passwordConfigured: !!settings.password };
}
export async function saveAuthSettings(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Account settings must be an object.');
  const previous = await loadAuthSettings();
  const patch = input as Record<string, unknown>;
  // An empty password from the write-only dashboard keeps the saved password.
  const settings = validateAuthSettings({ ...previous, ...patch, password: patch.password === '' || patch.password === undefined ? previous.password : patch.password });
  await fs.mkdir('config', { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(`${file}.tmp`, 0o600);
  await fs.rename(`${file}.tmp`, file);
  return authSummary(settings);
}
export function credentialsAllowed(url: string, settings: AuthSettings): boolean {
  const parsed = new URL(url);
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && settings.allowedHosts.some(host =>
    host.startsWith('*.') ? parsed.hostname.endsWith(host.slice(1)) && parsed.hostname !== host.slice(2) : parsed.hostname === host);
}
