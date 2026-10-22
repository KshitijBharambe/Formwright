import { promises as fs } from 'node:fs';
import { loadNotionAnswers, type NotionConfig } from './notion.js';
import { answerQuestionKey } from './answers.js';
import type { AnswerBank } from './types.js';

/** Configured Notion answers are authoritative; local JSON supplements other questions. */
export interface AnswerSnapshot {
  effective: AnswerBank;
  entries: { question: string; answer: string; source: 'Notion' | 'Local config' }[];
  fetchedAt: string;
}
function snapshot(local: AnswerBank, remote: AnswerBank = {}): AnswerSnapshot {
  const keys = new Set(Object.keys(remote).map(answerQuestionKey));
  const supplement = Object.fromEntries(Object.entries(local).filter(([q]) => !keys.has(answerQuestionKey(q))));
  return {
    effective: { ...supplement, ...remote },
    entries: [
      ...Object.entries(remote).map(([question, answer]) => ({ question, answer, source: 'Notion' as const })),
      ...Object.entries(supplement).map(([question, answer]) => ({ question, answer, source: 'Local config' as const }))
    ],
    fetchedAt: new Date().toISOString()
  };
}
export async function loadAnswers(): Promise<AnswerBank> {
  return (await loadAnswerSnapshot()).effective;
}
export async function loadAnswerSnapshot(): Promise<AnswerSnapshot> {
  let local: AnswerBank = {};
  try {
    local = JSON.parse(await fs.readFile('config/answers.json', 'utf8'));
    if (!local || typeof local !== 'object' || Array.isArray(local) || Object.values(local).some(v => typeof v !== 'string')) {
      throw new Error('config/answers.json must map questions to answer strings.');
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let config: NotionConfig;
  try { config = JSON.parse(await fs.readFile('config/notion.json', 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return snapshot(local); throw new Error('Could not read config/notion.json. Check that it contains valid JSON.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config/notion.json must be a JSON object.');
  if (!config.answerBank) return snapshot(local);
  if (typeof config.answerBank.dataSourceId !== 'string' || !config.answerBank.dataSourceId.trim()) {
    throw new Error('Set answerBank.dataSourceId in config/notion.json.');
  }
  const remote = await loadNotionAnswers(config.answerBank, config.token);
  return snapshot(local, remote);
}
