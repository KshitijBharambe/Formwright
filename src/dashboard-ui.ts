import { readFile } from 'node:fs/promises';

// Assets stay plain and editable; both src/ and dist/ resolve the same web/ directory.
const template = await readFile(new URL('../web/dashboard.html', import.meta.url), 'utf8');
export const dashboardCSS = await readFile(new URL('../web/dashboard.css', import.meta.url), 'utf8');
export const dashboardJS = await readFile(new URL('../web/dashboard.js', import.meta.url), 'utf8');
export const themeJS = await readFile(new URL('../web/theme.js', import.meta.url), 'utf8');
export function dashboardHTML(token: string) {
  return template.replace('FORMWRIGHT_CSRF_TOKEN', token);
}
