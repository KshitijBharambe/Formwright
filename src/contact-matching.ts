import { questionText } from './answers.js';

export function isCityQuestion(label: string): boolean {
  return ['city', 'current city', 'city of residence', 'location (city)', 'current location'].includes(questionText(label));
}

export function isPhoneCountryQuestion(label: string): boolean {
  return ['phone country', 'phone country code', 'telephone country code', 'dialing code'].includes(questionText(label));
}

/** Formatting may change, but no digits, dialing prefixes, or extensions may disappear. */
export function phoneMatches(actual: string, expected: string): boolean {
  const digits = (value: string): string | undefined => {
    if (!/^\+?[\d\s().-]+$/.test(value.trim())) return undefined;
    const result = value.replace(/\D/g, '');
    return result.length >= 7 && result.length <= 15 ? result : undefined;
  };
  const a = digits(actual), b = digits(expected);
  return a !== undefined && b !== undefined && a === b;
}
