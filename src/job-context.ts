import type { ApplicationScope } from './form-detection.js';

/** Read job location only. The candidate's address cannot establish work eligibility. */
export async function applicationCountry(page: ApplicationScope): Promise<string | undefined> {
  const evidence = await page.evaluate(() => {
    const countries: string[] = [];
    function read(value: any) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(read); return; }
      if (value['@graph']) read(value['@graph']);
      if ([value['@type']].flat().includes('JobPosting')) {
        for (const location of [value.jobLocation].flat().filter(Boolean)) {
          const country = location.address?.addressCountry;
          const name = typeof country === 'string' ? country : country?.name;
          if (typeof name === 'string' && name.trim()) countries.push(name);
          else countries.push('unknown');
        }
      }
    }
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { read(JSON.parse(script.textContent ?? '')); } catch {}
    }
    return { countries, locations: [...document.querySelectorAll('.job__location')].map(el => el.textContent?.trim() ?? '') };
  });
  if (evidence.countries.length) {
    return evidence.countries.every(country => /^(US|USA|United States(?: of America)?)$/i.test(country.trim())) ? 'US' : undefined;
  }
  // Explicit US country labels or unambiguous city labels observed in job headers.
  const usLocations = /^(?:New York City|New York, NY|San Francisco, CA|Syracuse, NY|United States(?: of America)?|USA|US)$/i;
  return evidence.locations.length > 0 && evidence.locations.every(value => usLocations.test(value)) ? 'US' : undefined;
}
