import { answerQuestionKey, getAnswer, resolveApprovedAnswer } from './answers.js';
import type { AnswerBank, JobResult, Profile } from './types.js';

export function supplementalAnswers(approved: AnswerBank, application: AnswerBank = {}): AnswerBank {
  // Live approved answers always win, including equivalent wording.
  return { ...Object.fromEntries(Object.entries(application).filter(([question]) =>
    resolveApprovedAnswer(question, approved).status === 'unmatched')), ...approved };
}

export function applicationQuestions(result: JobResult | undefined, profile: Profile, answers: AnswerBank) {
  const missing = result?.status === 'needs_answers' ? result.missing ?? [] : [];
  return missing.map((field, index) => {
    let reason: string | undefined;
    if (!field.label.trim() || !['text', 'textarea', 'email', 'tel', 'url', 'number', 'date', 'select', 'select-one', 'select-multiple',
      'radio', 'checkbox', 'combobox', 'input', 'search'].includes(field.type) || /password|captcha|verification code|one.time code/i.test(field.label)) {
      reason = 'Complete this step in the application browser, then queue a retry.';
    } else if (missing.filter(other => answerQuestionKey(other.label) === answerQuestionKey(field.label)).length > 1) {
      reason = 'This question appears more than once. Complete it in the browser so each answer reaches the right field.';
    } else if (getAnswer(field.label, profile, answers) !== undefined || resolveApprovedAnswer(field.label, answers).status !== 'unmatched') {
      reason = 'An answer already exists in your profile or Answer Bank. Review the employer’s options in the browser.';
    }
    return { ...field, index, canAnswer: !reason, reason };
  });
}
