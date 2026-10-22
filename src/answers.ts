import type { AnswerBank, Profile } from './types.js';
import { officeAttendanceKey } from './office-attendance.js';

const standard = new Map<string, keyof Profile>([
  ['first name', 'firstName'], ['given name', 'firstName'],
  ['last name', 'lastName'], ['family name', 'lastName'], ['surname', 'lastName'],
  ['full name', 'fullName'], ['name', 'fullName'], ['your name', 'fullName'],
  ['email', 'email'], ['email address', 'email'], ['e mail', 'email'],
  ['phone', 'phone'], ['phone number', 'phone'], ['mobile number', 'phone'],
  ['city', 'city'], ['current city', 'city'],
  ['location (city)', 'city'], ['country', 'country'],
  ['state', 'state'], ['province', 'state'],
  ['postal code', 'postalCode'], ['zip code', 'postalCode'], ['zip', 'postalCode'],
  ['linkedin', 'linkedin'], ['linkedin profile', 'linkedin'], ['linkedin url', 'linkedin'],
  ['github', 'github'], ['github profile', 'github'], ['github url', 'github'],
  ['portfolio', 'website'], ['website', 'website'], ['personal website', 'website']
]);

export const normalize = (s: string): string => s.normalize('NFKC').toLowerCase()
  .replace(/[‘’]/g, "'")
  .replace(/[\u00a0\s]+/g, ' ').replace(/[*✱?!.:,;]+/g, '')
  .replace(/\s+/g, ' ').trim();

export const questionText = (s: string): string => normalize(s)
  .replace(/(?:\s*\((?:required|optional|select all that apply|choose all that apply|select one|choose one)\))+$/g, '').trim();

// Explicit equivalence groups, not approximate text similarity. Keep current-only
// sponsorship and country-specific authorization separate from broader questions.
const equivalentQuestions = [
  [
    'Will you now or in the future require employment sponsorship?',
    'Will you now or in the future require visa sponsorship?',
    'Will you now or in the future require sponsorship for employment visa status?',
    'Will you now or at any time in the future require visa sponsorship?',
    'Do you now or in the future require sponsorship for employment visa status?',
    'Do you now or will you in the future require visa sponsorship?',
    'Will you require visa sponsorship now or in the future?',
    'Will you require sponsorship now or in the future?',
    'Do you require visa sponsorship now or in the future?',
    'Will you now or in the future require sponsorship for an employment visa?',
    'Do you require sponsorship, now or in the future, for permanent employment? (e.g., H-1B visa status)?'
  ],
  ['Are you legally authorized to work in the United States?', 'Are you authorized to work in the US?', 'Are you legally authorized to work in the U.S.?', 'Are you legally authorized to work in the United States of America?', 'Are you currently authorized to work in the United States?', 'Are you legally eligible to work in the United States?', 'Do you have authorization to work in the United States?'],
  [
    'Do you now or in the future require visa sponsorship to work in the United States?',
    'Will you now or in the future require visa sponsorship to work in the United States?',
    'Will you require visa sponsorship now or in the future to work in the United States?'
  ],
  ['Do you currently require visa sponsorship?', 'Do you currently require employment visa sponsorship?', 'Do you require visa sponsorship at this time?'],
  ['Will you require visa sponsorship in the future?', 'Will you need visa sponsorship in the future?'],
  ['Are you willing to relocate?', 'Are you open to relocation?', 'Would you be willing to relocate?', 'Willing to relocate'],
  ['Are you open to remote work?', 'Are you willing to work remotely?'],
  ['What is your LinkedIn URL?', 'LinkedIn Profile', 'LinkedIn URL', 'LinkedIn'],
  ['What is your email address?', 'Email', 'Email address', 'E-mail'],
  ['How did you hear about this role?', 'How did you initially hear about this job?', 'How did you hear about this job?'],
  ['Gender', 'What is your gender?'],
  ['Degree', 'Degree type', 'Type of degree', 'Academic degree'],
  ['What degree do you hold?', 'What is your degree?', 'What academic degree do you hold?'],
  ['Highest level of education', 'Highest education level', 'What is your highest level of education?', 'Highest degree earned', 'What is the highest degree you have earned?'],
  ['School', 'University', 'School name', 'College / University', 'College or university', 'University name'],
  ['Discipline', 'Field of study', 'Major', 'Academic major'],
  ['First name', 'Given name', 'What is your first name?'],
  ['Last name', 'Family name', 'Surname', 'What is your last name?'],
  ['Full name', 'Name', 'Your name', 'What is your full name?'],
  ['Phone', 'Phone number', 'What is your phone number?', 'Telephone number', 'Contact phone number'],
  ['GitHub', 'GitHub profile', 'GitHub URL', 'What is your GitHub URL?'],
  ['Postal code', 'ZIP code', 'ZIP', 'ZIP / Postal code', 'Postal / ZIP code'],
  ['City', 'Current city', 'City of residence', 'Current location', 'Location (City)'],
  ['Website', 'Personal website', 'Portfolio', 'Portfolio URL'],
  ['Street address', 'Address line 1'],
  ['Address line 2', 'Apartment / Suite']
];
const questionKeys = new Map(equivalentQuestions.flatMap((group, i) => group.map(q => [questionText(q), `equivalent:${i}`] as const)));
export function answerQuestionKey(question: string): string {
  const text = questionText(question);
  return questionKeys.get(text) ?? officeAttendanceKey(text) ?? text;
}
const standardKeys = new Map([...standard].map(([label, key]) => [answerQuestionKey(label), key]));
export function binaryAnswer(answer: string): string | undefined {
  return answer.trim().match(/^(yes|no)(?:[,.!]\s|[,.!]?$)/i)?.[1];
}
export function resolveApprovedAnswer(label: string, bank: AnswerBank):
  { status: 'matched'; answer: string } | { status: 'conflict' | 'unmatched' } {
  const usable = Object.entries(bank).filter(([, value]) => typeof value === 'string' && !!value.trim() && !/^(YOUR_|REPLACE_WITH_)/i.test(value));
  const key = answerQuestionKey(label);
  const candidates = usable.filter(([question]) => answerQuestionKey(question) === key).map(([, value]) => value);
  if (!candidates.length) return { status: 'unmatched' };
  // Disagreeing equivalent answers must not be resolved by object insertion order.
  const signatures = new Set(candidates.map(value => binaryAnswer(value)?.toLowerCase() ?? normalize(value)));
  return signatures.size === 1 ? { status: 'matched', answer: candidates[0] } : { status: 'conflict' };
}
export function approvedAnswer(label: string, bank: AnswerBank): string | undefined {
  const resolved = resolveApprovedAnswer(label, bank);
  return resolved.status === 'matched' ? resolved.answer : undefined;
}

// Fail closed: no fuzzy guessing for legal, immigration, eligibility, or demographic answers.
export function getAnswer(label: string, profile: Profile, bank: AnswerBank, jobCountry?: string): string | undefined {
  const n = questionText(label);
  const custom = resolveApprovedAnswer(label, bank);
  if (custom.status === 'matched') return custom.answer;
  if (custom.status === 'conflict') return undefined;
  if (n === 'are you legally authorized to work in the country where this job is located' && jobCountry === 'US') {
    return approvedAnswer('Are you legally authorized to work in the United States?', bank);
  }
  // Exact city/state question only; do not infer answers for unrelated prompts.
  if (n === 'what city and state do you reside in' || n === 'city and state of residence') {
    if (profile.city && profile.state && !profile.city.startsWith('YOUR_') && !profile.state.startsWith('YOUR_')) {
      return `${profile.city}, ${profile.state}`;
    }
    return undefined;
  }
  const key = standardKeys.get(answerQuestionKey(label));
  const value = key ? profile[key] : undefined;
  if (typeof value === 'string' && value.trim() && !value.startsWith('YOUR_')) return value;
  return undefined;
}
