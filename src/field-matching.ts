import { normalize } from './answers.js';
import type { Profile } from './types.js';
import { degreeMeaning, isDegreeQuestion } from './degree-matching.js';
import { isCityQuestion, isPhoneCountryQuestion } from './contact-matching.js';

const US_STATES: Record<string, string> = { NY: 'new york', CA: 'california', TX: 'texas', NJ: 'new jersey', MA: 'massachusetts', PA: 'pennsylvania', WA: 'washington', IL: 'illinois', FL: 'florida', VA: 'virginia' };
function tokens(s: string): string {
  return normalize(s).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
export type OptionResolution = { status: 'matched'; option: string; method: 'exact' | 'equivalent' | 'generalized' }
  | { status: 'ambiguous' | 'unmatched' };
function unique(options: string[], method: 'exact' | 'equivalent' | 'generalized'): OptionResolution {
  return options.length === 1 ? { status: 'matched', option: options[0], method }
    : { status: options.length ? 'ambiguous' : 'unmatched' };
}
export function resolveOption(options: string[], answer: string, label: string, profile: Pick<Profile, 'state'> = {}): OptionResolution {
  const exact = options.filter(o => tokens(o) === tokens(answer));
  if (exact.length) return unique(exact, 'exact');
  if (isPhoneCountryQuestion(label) && /^\+[\d\s().-]+$/.test(answer.trim())) {
    const number = answer.replace(/\D/g, '');
    const candidates = options.flatMap(option => {
      const code = option.match(/(?:^|\()\s*\+(\d{1,4})\s*\)?$/)?.[1];
      return code && number.startsWith(code) ? [{ option, code }] : [];
    });
    const longest = Math.max(0, ...candidates.map(candidate => candidate.code.length));
    return unique(candidates.filter(candidate => candidate.code.length === longest).map(candidate => candidate.option), 'equivalent');
  }
  // Only complete binary tokens are equivalent. Never strip qualifiers from an
  // employer's option ("Yes, but only ..." can assert a different fact).
  const booleanToken = (value: string) => /^(yes|true|y)$/.test(tokens(value)) ? true : /^(no|false|n)$/.test(tokens(value)) ? false : undefined;
  const binary = booleanToken(answer);
  if (binary !== undefined) {
    const matches = options.filter(option => booleanToken(option) === binary);
    if (matches.length) return unique(matches, 'equivalent');
  }
  if (/^country\b/i.test(label) && /^(united states|usa|us)$/i.test(answer.trim())) {
    const countries = options.filter(o => /^(united states|united states of america|usa)(\s*\+1)?$/i.test(o.trim()));
    if (countries.length) return unique(countries, 'equivalent');
  }
  if (isCityQuestion(label) && profile.state) {
    const city = tokens(answer);
    const state = tokens(US_STATES[profile.state.toUpperCase()] || profile.state);
    const abbr = tokens(Object.entries(US_STATES).find(([, full]) => full === state)?.[0] || profile.state);
    const matches = options.filter(o => {
      const v = tokens(o);
      const parts = o.split(',').map(tokens);
      return parts[0] === city && parts.slice(1).some(part => part === abbr || part === state);
    });
    if (matches.length) return unique(matches, 'equivalent');
  }
  if (isDegreeQuestion(label)) {
    const meaning = degreeMeaning(answer);
    if (meaning) {
      const same = options.filter(option => {
        const candidate = degreeMeaning(option);
        return candidate?.level === meaning.level && candidate.qualification === meaning.qualification;
      });
      if (same.length) return unique(same, 'equivalent');
      if (meaning.qualification !== undefined) {
        const general = options.filter(option => {
          const candidate = degreeMeaning(option);
          return candidate?.level === meaning.level && candidate.qualification === undefined;
        });
        if (general.length) return unique(general, 'generalized');
      }
    }
  }
  return { status: 'unmatched' };
}
export function chosenOption(options: string[], answer: string, label: string, profile: Pick<Profile, 'state'> = {}): string | undefined {
  const result = resolveOption(options, answer, label, profile);
  return result.status === 'matched' ? result.option : undefined;
}
