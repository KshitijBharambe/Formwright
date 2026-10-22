import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fillApplication } from '../dist/form.js';
import { inspectFields } from '../dist/field-inspection.js';
import { annotateFields } from '../dist/simplify.js';

const profile = { firstName:'Alex',lastName:'Example',fullName:'Alex Example',email:'alex@example.test',phone:'+13155550100',city:'Syracuse',state:'New York',resumePath:import.meta.filename };
const sponsorship = 'Will you now or in the future require visa sponsorship?';
const country = 'Which country do you intend to primarily work from?';
const bank = { [sponsorship]:'Yes', [country]:'United States' };
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  let network = 0;
  await page.route('**/*',route=>{network++;return route.abort();});
  const fixture = async ({reject=false,ambiguous=false,reset=false,stale=false}={}) => {
    await page.setContent(`<label>Outside email<input type="email" id="outside"></label><form class="application-form">
      <li class="application-question"><div class="application-label">Full name<span>✱</span></div><div class="application-field"><input name="name" required></div></li>
      <li class="application-question"><div class="application-label">Email<span>✱</span></div><div class="application-field"><input name="email" type="email" required></div></li>
      <li class="application-question"><div class="application-label">Current location</div><div class="application-field"><input id="location-input" name="location"><input type="hidden" id="selected-location" name="selectedLocation"><div class="dropdown-results"></div></div></li>
      <li class="application-question"><div class="application-label"><div class="text">${sponsorship}<span>✱</span></div></div><div class="application-field"><ul><li><label><input type="radio" name="sponsor" value="Yes" required>Yes</label></li><li><label><input type="radio" name="sponsor" value="No" required>No</label></li></ul></div></li>
      <li class="application-question"><div class="application-label"><div class="text">${country}<span>✱</span></div></div><div class="application-field"><select name="work-country" required><option value="">Select...</option><option>United States</option><option>Canada</option></select></div></li>
      <li class="application-question"><div class="application-label"><div class="text">May we share your information with related groups?<span>✱</span></div></div><div class="application-field"><label><input type="radio" name="share" value="Yes" required>Yes</label><label><input type="radio" name="share" value="No" required>No</label></div></li>
      <li class="application-question"><div class="application-label">What is your earliest available start date?<span>✱</span></div><div class="application-field"><input name="start"></div></li>
      <button id="btn-submit" type="submit">Submit application</button></form>`);
    await page.evaluate(({reject,ambiguous,reset,stale})=>{
      document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submitted=true;};
      const input=document.querySelector('#location-input'),selected=document.querySelector('#selected-location'),list=document.querySelector('.dropdown-results');
      if(stale){input.value='Old city';selected.value='old-selection';}
      input.oninput=()=>{
        if(!stale)selected.value='';list.replaceChildren();
        if(!input.value)return;
        for(const label of ambiguous ? ['Syracuse, NY, USA','Syracuse, New York, United States'] : ['Syracuse, UT, USA','Syracuse, NY, USA']) {
          const option=document.createElement('div');option.className='dropdown-location';option.textContent=label;
          option.onclick=()=>{list.replaceChildren();input.value=label;if(!reject)selected.value=JSON.stringify({name:label});if(reset)setTimeout(()=>{selected.value='';},400);};
          list.append(option);
        }
      };
    },{reject,ambiguous,reset,stale});
  };
  await fixture();
  let result=await fillApplication(page,profile,bank,'Lever');
  assert.equal(await page.locator('[name=sponsor][value=Yes]').isChecked(),true,'Lever required glyph must not block approved answers');
  assert.ok(await page.locator('#selected-location').inputValue(),'Location must be a selected suggestion, not typed text');
  assert.equal(await page.locator('#location-input').inputValue(),'Syracuse, NY, USA');
  assert.equal(await page.locator('[name=work-country]').inputValue(),'United States');
  assert.equal(await page.locator('#outside').inputValue(),'');
  assert.deepEqual(result.missing.map(x=>x.name).sort(),['share','start']);
  await annotateFields(page,'Lever');
  assert.equal((await inspectFields(page)).find(x=>x.id==='location-input').kind,'combobox');
  result=await fillApplication(page,profile,bank,'Lever');
  assert.deepEqual(result.filled,[],'Second run is idempotent');
  assert.deepEqual(result.missing.map(x=>x.name).sort(),['share','start']);
  for(const mode of [{reject:true},{ambiguous:true},{reset:true},{reject:true,stale:true}]) {
    await fixture(mode);
    result=await fillApplication(page,profile,bank,'Lever');
    assert.ok(result.missing.some(x=>x.id==='location-input'),'Uncommitted or ambiguous location must remain unresolved');
  }
  await fixture();
  result=await fillApplication(page,profile,{},'Lever');
  assert.equal(result.missing.filter(x=>x.name==='sponsor').length,1);
  assert.ok(!result.missing.some(x=>x.type==='validation'),'Required radio options must report one question, not individual Yes/No errors');
  assert.equal(await page.locator('[name=share]:checked').count(),0);
  assert.equal(await page.evaluate(()=>window.submitted||false),false);
  assert.equal(network,0);
  console.log('PASS: Lever required glyph, approved radios/selects, scoped profile filling, committed location, ambiguity/rejection/reset, idempotency, question-level validation, unknown consent/start date, no network/submission.');
} finally { await browser.close(); }
