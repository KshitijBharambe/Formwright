import { answerQuestionKey, normalize } from './answers.js';

// A specific qualification may map to its general level, never to a different
// specialty or from a general level to an unapproved specific qualification.
const degrees = [
  { level: 'master', aliases: ['Master of Science', 'Masters of Science', 'MS', 'MSc'] },
  { level: 'master', aliases: ['Master of Arts', 'Masters of Arts', 'MA'] },
  { level: 'master', aliases: ['Master of Engineering', 'Masters of Engineering', 'MEng', 'ME'] },
  { level: 'master', aliases: ['Master of Business Administration', 'Masters of Business Administration', 'MBA'] },
  { level: 'bachelor', aliases: ['Bachelor of Science', 'Bachelors of Science', 'BS', 'BSc'] },
  { level: 'bachelor', aliases: ['Bachelor of Arts', 'Bachelors of Arts', 'BA'] },
  { level: 'bachelor', aliases: ['Bachelor of Engineering', 'Bachelors of Engineering', 'BE', 'BEng'] },
  { level: 'doctorate', aliases: ['Doctor of Philosophy', 'PhD', 'DPhil'] },
  { level: 'associate', aliases: ['Associate of Science', 'AS'] },
  { level: 'associate', aliases: ['Associate of Arts', 'AA'] }
] as const;
const generic: Record<string, string[]> = {
  master: ['Master', 'Masters', "Master's", 'Master degree', 'Masters degree', "Master's degree"],
  bachelor: ['Bachelor', 'Bachelors', "Bachelor's", 'Bachelor degree', 'Bachelors degree', "Bachelor's degree"],
  doctorate: ['Doctorate', 'Doctoral degree', 'Doctorate degree'],
  associate: ['Associate', 'Associates', "Associate's", 'Associate degree', 'Associates degree', "Associate's degree"]
};
const key = (value: string) => normalize(value).replace(/[^a-z0-9]+/g, '');
export function isDegreeQuestion(label: string): boolean {
  const question = answerQuestionKey(label);
  return question === answerQuestionKey('Degree') || question === answerQuestionKey('What degree do you hold?') ||
    question === answerQuestionKey('Highest level of education');
}
export function degreeMeaning(value: string): { level: string; qualification?: number } | undefined {
  const normalized = key(value);
  for (const [qualification, degree] of degrees.entries()) {
    if (degree.aliases.some(alias => key(alias) === normalized)) return { level: degree.level, qualification };
    // Common catalogs include the abbreviation alongside the full degree name.
    const annotated = value.match(/^(.+?)\s*\(([^()]+)\)$/);
    if (annotated && degree.aliases.some(alias => key(alias) === key(annotated[1])) &&
        degree.aliases.some(alias => key(alias) === key(annotated[2]))) return { level: degree.level, qualification };
  }
  for (const [level, aliases] of Object.entries(generic)) {
    if (aliases.some(alias => key(alias) === normalized)) return { level };
  }
  return undefined;
}

/** Search wording only; every returned option still goes through the resolver. */
export function optionSearchTerms(answer: string, label: string): string[] {
  const meaning = isDegreeQuestion(label) ? degreeMeaning(answer) : undefined;
  return [...new Set([answer, ...(meaning ? [meaning.level === 'doctorate' ? 'Doctor' : meaning.level] : [])])];
}
