import assert from 'node:assert/strict';
import { fieldAnswer } from '../dist/profile-values.js';
import { answerQuestionKey } from '../dist/answers.js';

const field = label => ({ label, kind: 'combobox' });
// Synthetic approved answer; this fixture does not define the applicant's demographics.
const bank = { 'What is your gender?': 'Fixture option' };
assert.equal(fieldAnswer(field('Gender'), {}, bank), 'Fixture option',
  'The screenshot label Gender must match the explicitly approved gender question');
assert.equal(answerQuestionKey('Gender'), answerQuestionKey('What is your gender?'));
for (const label of ['Are you Hispanic/Latino?', 'Veteran Status', 'Race', 'Sex assigned at birth', 'Gender identity']) {
  assert.equal(fieldAnswer(field(label), {}, bank), undefined, `${label} must not be inferred from another answer`);
}
assert.equal(fieldAnswer(field('Gender'), {}, {}), undefined, 'Missing approved gender stays unanswered');
assert.equal(fieldAnswer(field('Gender'), {}, { Gender: 'Option A', 'What is your gender?': 'Option B' }), undefined,
  'Conflicting equivalent answers require review');
assert.equal(fieldAnswer(field('Are you Hispanic/Latino?'), {}, { 'Are you Hispanic/Latino?': 'No' }), 'No');
assert.equal(fieldAnswer(field('Veteran Status'), {}, { 'Veteran Status': 'Approved exact option' }), 'Approved exact option');
console.log('PASS: Gender wording equivalence, conflict rejection, exact approved demographic answers, and no cross-question inference.');
