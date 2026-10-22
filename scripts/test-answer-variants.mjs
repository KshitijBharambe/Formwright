import assert from 'node:assert/strict';
import { fieldAnswer } from '../dist/profile-values.js';
import { chosenOption } from '../dist/field-matching.js';
import { educationRecords } from '../dist/education-values.js';
const bank = {
 'Will you now or in the future require employment sponsorship?': 'Yes, I will require employer sponsorship in the future.',
 'Are you legally authorized to work in the United States?': 'Yes. I am currently authorized under F-1 STEM OPT.',
 'What degree do you hold?': 'Master of Science in Computer Science (Syracuse University, May 2025) and Bachelor of Engineering in Computer Engineering (New Horizon Institute of Technology and Management, May 2023).'
};
const answer = (label, options = {}, profile = {}) => fieldAnswer({label,kind:'combobox',...options},profile,bank);
assert.equal(answer('Will you now or in the future require visa sponsorship? *'),'Yes');
assert.equal(answer('Will you now or in the future require visa sponsorship?', {kind:'textarea'}),bank['Will you now or in the future require employment sponsorship?']);
assert.equal(answer('Are you legally authorized to work in the country where this job is located?*',{jobCountry:'US'}),'Yes');
assert.equal(answer('Are you legally authorized to work in the country where this job is located?*'),undefined);
assert.equal(answer('Are you legally authorized to work in the country where this job is located?*',{jobCountry:'CA'}),undefined);
assert.equal(answer('Are you legally authorized to work in Canada?'),undefined);
assert.equal(answer('Do you currently require visa sponsorship?'),undefined);
assert.equal(answer('Will you NOT require visa sponsorship?'),undefined);
assert.equal(answer('School',{id:'school--0'}),'Syracuse University');
assert.equal(answer('Degree',{id:'degree--0'}),'Master of Science');
assert.equal(answer('School',{id:'school--1'}),'New Horizon Institute of Technology and Management');
assert.equal(answer('Degree',{id:'degree--1'}),'Bachelor of Engineering');
assert.equal(answer('School',{id:'school--2'}),undefined);
assert.equal(chosenOption(["Bachelor's Degree", "Master's Degree", 'Doctorate'],answer('Degree'),'Degree',{}),"Master's Degree");
assert.equal(chosenOption(['Master of Arts'],answer('Degree'),'Degree',{}),undefined);
assert.equal(answer('Select ‘Yes’ to join Braze’s Talent Community and receive newsletters.'),undefined);
assert.equal(answer('Will you be able to regularly commute and work in an office in job posting location?'),undefined);
assert.equal(answer('How did you initially hear about this job?'),undefined);
assert.deepEqual(educationRecords({}, {'What degree do you hold?':'Please check the resume.'}),[]);
assert.equal(answer('School',{}, {education:[{school:'Explicit School',degree:'Explicit Degree'}]}),'Explicit School');
assert.equal(fieldAnswer({label:'Will you now or in the future require visa sponsorship?',kind:'combobox'}, {}, {
 ...bank, 'Will you now or in the future require sponsorship for employment visa status?':'No'
}),undefined);
console.log('PASS: Braze question variants, country boundaries, comma-prefixed binary answers, education records, conflicts, and unknowns.');
