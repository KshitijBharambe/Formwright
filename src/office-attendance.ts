/** Bounded whole-question templates. Never discard conditions or infer willingness. */
export function officeAttendanceKey(question: string): string | undefined {
  const location = '(nyc|new york city|san francisco|downtown san francisco)';
  const days = '(one|two|three|four|five|six|seven|[1-7])';
  const frequency = `${days} days? (?:a|per) week`;
  const patterns = [
    new RegExp(`^are you comfortable working out of (?:our|the) ${location} office ${frequency}$`),
    new RegExp(`^are you (?:willing|able) to work (?:from|in|out of) (?:our|the) ${location} office ${frequency}$`),
    new RegExp(`^we are based in ${location} and require in-person attendance ${frequency} are you able to meet this requirement$`)
  ];
  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (!match) continue;
    const city = match[1] === 'nyc' ? 'new york city' : match[1];
    const number = ({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 } as Record<string, number>)[match[2]] ?? Number(match[2]);
    return `office-attendance:${city}:${number}`;
  }
  return undefined;
}
