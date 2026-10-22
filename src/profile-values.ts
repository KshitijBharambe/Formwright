import type { AnswerBank, Field, Profile } from './types.js';
import { getAnswer, binaryAnswer, answerQuestionKey, approvedAnswer, resolveApprovedAnswer } from './answers.js';
import { educationRecords } from './education-values.js';
import { degreeMeaning } from './degree-matching.js';
import { isPhoneCountryQuestion } from './contact-matching.js';
const keys: Record<string, keyof Profile> = {
  first_name: 'firstName', last_name: 'lastName', full_name: 'fullName',
  email: 'email', email_confirm: 'email', phone: 'phone', mobile_phone: 'phone',
  city: 'city', country: 'country', state: 'state', postal_code: 'postalCode',
  address: 'address', address_2: 'address2', linkedin: 'linkedin', github: 'github',
  portfolio: 'website', website: 'website', coverLetter: 'coverLetterText'
};
const educationFields = new Map<string, 'school' | 'degree' | 'fieldOfStudy'>([
  [answerQuestionKey('School'), 'school'], [answerQuestionKey('Degree'), 'degree'],
  [answerQuestionKey('Field of study'), 'fieldOfStudy']
]);
const valid = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !/^(YOUR_|REPLACE_WITH_)/i.test(value);
export function fieldAnswer(field: Field, profile: Profile, bank: AnswerBank): string | undefined {
  if (resolveApprovedAnswer(field.label, bank).status === 'conflict') return undefined;
  const approved = getAnswer(field.label, profile, bank, field.jobCountry);
  if (approved !== undefined) {
    // Canonical answers can start "Yes. <explanation>"; keep prose for text fields.
    const binary = binaryAnswer(approved);
    if (binary && (field.choice || ['select', 'radio', 'combobox', 'checkbox', 'switch', 'toggle', 'listbox'].includes(field.kind))) return binary;
    return approved;
  }
  const educationKey = educationFields.get(answerQuestionKey(field.label));
  if (educationKey) {
    const index = Number(field.id?.match(/^(?:school|degree|discipline|field_of_study)--(\d+)$/)?.[1] ?? 0);
    const value = educationRecords(profile, bank)[index]?.[educationKey];
    if (valid(value)) return value;
    if (educationKey === 'degree' && index === 0) {
      const degree = approvedAnswer('What degree do you hold?', bank);
      if (degree && degreeMeaning(degree)) return degree;
    }
  }
  if (isPhoneCountryQuestion(field.label)) {
    if (valid(profile.autofill?.phone_country)) return profile.autofill.phone_country;
    // Match dialing-code options from an explicitly international approved phone.
    // This supplies no claim about nationality, residence, or work authorization.
    const phone = resolveApprovedAnswer('Phone number', bank);
    if (phone.status === 'conflict') return undefined;
    const value = phone.status === 'matched' ? phone.answer : profile.phone;
    return typeof value === 'string' && /^\+[\d\s().-]+$/.test(value.trim()) ? value : undefined;
  }
  const semantic = field.semanticKey;
  if (!semantic) return undefined;
  // Values here are explicitly supplied by the user, including any sensitive keys.
  if (Object.hasOwn(profile.autofill ?? {}, semantic)) {
    const value = profile.autofill![semantic];
    if (!valid(value)) return undefined;
    return field.choice || ['select', 'radio', 'combobox', 'checkbox', 'switch', 'toggle', 'listbox'].includes(field.kind) ? binaryAnswer(value) ?? value : value;
  }
  const key = keys[semantic];
  const value = key ? profile[key] : undefined;
  return valid(value) ? value : undefined;
}
