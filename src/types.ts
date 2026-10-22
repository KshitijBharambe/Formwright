export interface Language {
  name: string;
  native?: boolean;
  reading?: string;
  writing?: string;
  speaking?: string;
  listening?: string;
  overall?: string;
  level?: string;
}
export interface Employment {
  title: string;
  company: string;
  location?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  current?: boolean;
}
export interface Education {
  school: string;
  degree?: string;
  fieldOfStudy?: string;
  gpa?: string;
  startDate?: string;
  endDate?: string;
}
export interface Profile {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  city?: string;
  country?: string;
  state?: string;
  postalCode?: string;
  linkedin?: string;
  github?: string;
  website?: string;
  resumePath: string;
  experience?: Employment[];
  education?: Education[];
  websites?: string[];
  languages?: Language[];
  skills?: string[];
  address?: string;
  address2?: string;
  coverLetterPath?: string;
  coverLetterText?: string;
  /** Explicit values keyed by Simplify semantic field name. No inferred answers. */
  autofill?: Record<string, string>;
}
export type AnswerBank = Record<string, string>;
export type ATS = string;
export type Status = 'submitted' | 'ready_for_review' | 'needs_answers' | 'needs_verification' | 'skipped' | 'error';
export interface QueuedJob {
  url: string;
  notion?: { pageId: string; pageUrl?: string; lastEditedTime?: string; title?: string; company?: string; status?: string; lifecycle?: string; statusOptions?: string[]; lifecycleOptions?: string[] };
}
export interface JobResult {
  notion?: QueuedJob['notion'];
  url: string;
  ats?: ATS;
  status: Status;
  message: string;
  timestamp: string;
  fieldsFilled?: string[];
  autofill?: import('./local-resolver.js').AutofillReport;
  steps?: number;
  entrySite?: string;
  resolvedUrl?: string;
  missing?: { label: string; type: string; options?: string[]; name?: string; id?: string; placeholder?: string; context?: string }[];
}
export interface Field {
  leverLocation?: boolean;
  /** Stable DOM owner identity distinguishes repeated questions and forms. */
  instanceKey?: string;
  choice?: { mode: 'single' | 'multiple' | 'boolean'; nativeSelect?: boolean };
  /** Country established from the job posting, never the applicant address. */
  jobCountry?: string;
  workdayPrompt?: boolean;
  workdayManaged?: boolean;
  semanticKey?: string;
  key: string;
  label: string;
  kind: string;
  required: boolean;
  options?: string[];
  name?: string;
  id?: string;
  placeholder?: string;
  context?: string;
}
