import assert from 'node:assert/strict';
import { chosenOption } from '../dist/field-matching.js';
import { getAnswer } from '../dist/answers.js';
const profile = {firstName:'Alex',lastName:'Test',email:'alex@example.com',city:'Syracuse',state:'NY',country:'United States'};
assert.equal(chosenOption(['Canada','United States','United Kingdom'], 'United States', 'Country*', profile),'United States');
assert.equal(chosenOption(['Syracuse, New York, United States','Syracuse, Utah, United States'], 'Syracuse', 'Location (City)*', profile),'Syracuse, New York, United States');
assert.equal(chosenOption(['Syracuse, New York','Syracuse, NY'], 'Syracuse', 'Location (City)*', profile),undefined);
assert.equal(getAnswer('What city and state do you reside in? *', profile,{}),'Syracuse, NY');
assert.equal(getAnswer('Do you require sponsorship, now or in the future, for permanent employment? (e.g., H-1B visa status)?*', profile,{}),undefined);
assert.equal(getAnswer('Do you require sponsorship, now or in the future, for permanent employment? (e.g., H-1B visa status)?*', profile,{
  'Do you require sponsorship, now or in the future, for permanent employment? (e.g., H-1B visa status)?':'Yes'
}),'Yes');
console.log('Option matching and approved-answer tests passed.');
