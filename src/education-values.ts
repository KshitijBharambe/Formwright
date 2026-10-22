import type { AnswerBank, Education, Profile } from './types.js';
import { approvedAnswer } from './answers.js';

/** Parse only the bank's explicit "Degree in Field (School, Month YYYY)" records. */
export function educationRecords(profile: Profile, bank: AnswerBank): Education[] {
  if (profile.education?.length) return profile.education;
  const answer = approvedAnswer('What degree do you hold?', bank);
  if (!answer) return [];
  const parts = answer.replace(/\.\s*$/, '').split(/\)\s*(?:and|;)\s*/);
  const records: Education[] = [];
  for (const part of parts) {
    const match = part.match(/^((?:Master|Bachelor|Doctor) of .+?) in (.+?) \((.+), ([A-Za-z]+ \d{4})\)?$/);
    if (!match) return []; // Partial or ambiguous prose is not structured education.
    const [, degree, fieldOfStudy, school] = match;
    records.push({ degree, fieldOfStudy, school });
  }
  return records;
}
