import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fillApplication } from '../dist/form.js';
import { fieldAnswer } from '../dist/profile-values.js';
import { chosenOption } from '../dist/field-matching.js';
import { phoneMatches } from '../dist/contact-matching.js';
import { LocalAnswerResolver } from '../dist/local-resolver.js';

const profile = { firstName:'Alex',lastName:'Example',fullName:'Alex Example',email:'alex@example.test',phone:'+1 315 555 0100',city:'Syracuse',state:'New York',resumePath:import.meta.filename };
const authorization = 'Are you legally authorized to work in the United States?';
const sponsorship = 'Do you or will you require sponsorship for a US employment visa?';
const bank = { [authorization]:'Yes. Explicit approved answer.', [sponsorship]:'Yes' };
assert.equal(phoneMatches('1 (315) 555-0100', profile.phone), true);
for (const actual of ['(315) 555-0100', '+44 315 555 0100', '+1 315 555 0101', '1 315 555 0100 ext 9']) assert.equal(phoneMatches(actual, profile.phone), false);
assert.equal(fieldAnswer({label:'Current location*',kind:'combobox'}, profile, {}), 'Syracuse');
assert.equal(chosenOption(['Syracuse, UT, USA','Syracuse, NY, USA'], 'Syracuse', 'Current location*', profile), 'Syracuse, NY, USA');
assert.equal(chosenOption(['Syracuse North, NY, USA','New Syracuse, NY, USA'], 'Syracuse', 'Current location*', profile), undefined);
assert.equal(chosenOption(['Syracuse, NY, USA','Syracuse, New York, United States'], 'Syracuse', 'Current location*', profile), undefined);
assert.equal(chosenOption(['US/Canada (+1)','United Kingdom (+44)'], profile.phone, 'Phone country', profile), 'US/Canada (+1)');
assert.equal(chosenOption(['US (+1)','Canada (+1)'], profile.phone, 'Phone country', profile), undefined);
assert.equal(chosenOption(['US/Canada (+1)','Barbados (+1246)'], '+1 246 555 0100', 'Phone country', profile), 'Barbados (+1246)');
assert.equal(fieldAnswer({label:'Phone country',kind:'combobox'}, {...profile,phone:'3155550100'}, {}), undefined);
assert.equal(fieldAnswer({label:'Phone country',kind:'combobox'}, profile, {'Phone':'No phone','Phone number':profile.phone}), undefined);
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage();
  let network=0;
  await page.route('**/*', route=>{network++;return route.abort();});
  const fixture = async ({ reject=false, ambiguous=false, badPhone=false }={}) => {
    await page.setContent(`<div role="dialog"><form>
      <input name="first_name" placeholder="First Name *"><input name="last_name" placeholder="Last Name *">
      <input type="email" placeholder="Email Address *"><input type="tel" placeholder="Phone Number" value="1 (315) 555-0100">
      <div class="css-13cymwt-control"><span class="css-1dimb5e-singleValue">US/Canada (+1)</span><input role="combobox" aria-label="Phone country" aria-expanded="false" id="phone-country"></div>
      <div class="css-13cymwt-control"><input role="combobox" placeholder="Current location*" id="city_current" name="city_current" aria-controls="city-options" aria-expanded="false"></div><div id="city-options" role="listbox"></div>
      <div><div>${authorization} *</div><div><label><input type="radio" name="us_authorized" value="true">Yes</label><label><input type="radio" name="us_authorized" value="false">No</label></div></div>
      <div><div>${sponsorship} *</div><div><label><input type="radio" name="us_visa_sponsorship" value="true">Yes</label><label><input type="radio" name="us_visa_sponsorship" value="false">No</label></div></div>
      <textarea placeholder="What interests you about Within?"></textarea><button type="submit">Submit</button>
    </form></div>`);
    await page.evaluate(({reject,ambiguous,badPhone})=>{
      const form=document.querySelector('form'); form.onsubmit=event=>{event.preventDefault();window.submitted=true;};
      const phone=document.querySelector('[type=tel]');
      phone.oninput=()=>{ phone.value=badPhone?'1 (315) 555-0101':'1 (315) 555-0100'; };
      if(badPhone)phone.value='wrong';
      const input=document.querySelector('#city_current'),list=document.querySelector('#city-options');
      const render=()=>{
        input.setAttribute('aria-expanded','true');list.replaceChildren();
        if(!input.value)return;
        for(const label of ambiguous ? ['Syracuse, NY, USA','Syracuse, New York, United States'] : ['Syracuse, UT, USA','Syracuse, NY, USA']) {
          const option=document.createElement('div');option.setAttribute('role','option');option.textContent=label;
          option.onclick=()=>{list.replaceChildren();input.value='';input.setAttribute('aria-expanded','false');if(!reject){const value=document.createElement('span');value.className='css-1dimb5e-singleValue';value.textContent=label;input.before(value);}};
          list.append(option);
        }
      };
      input.onclick=render;input.oninput=render;
      input.onkeydown=event=>{if(event.key==='Escape'){list.replaceChildren();input.setAttribute('aria-expanded','false');}};
    }, {reject,ambiguous,badPhone});
  };
  await fixture();
  const resolver = new LocalAnswerResolver({mode:'llm',baseUrl:'http://127.0.0.1:1/v1',model:'offline',maxCalls:1},profile,bank);
  let result=await fillApplication(page,profile,bank,'YCombinator',resolver);
  assert.deepEqual(result.missing, []);
  assert.equal(await page.locator('[name=us_authorized][value=true]').isChecked(),true);
  assert.equal(await page.locator('[name=us_visa_sponsorship][value=true]').isChecked(),true);
  assert.equal(await page.locator('#city_current').locator('..').locator('span').textContent(),'Syracuse, NY, USA');
  assert.equal(resolver.report.calls,0,'Known phone/city must not need an LLM call');
  assert.deepEqual((await fillApplication(page,profile,bank,'YCombinator')).filled,[]);
  assert.equal(await page.locator('textarea').inputValue(),'');

  await fixture();
  result=await fillApplication(page,profile,{[authorization]:'Yes','Will you now or in the future require employment sponsorship?':'Yes'},'YCombinator');
  assert.ok(result.missing.some(field=>field.name==='us_visa_sponsorship'), 'Unapproved US-specific question must be reported required, not silently skipped');
  assert.equal(await page.locator('[name=us_visa_sponsorship]:checked').count(),0);
  await fixture({reject:true});
  assert.ok((await fillApplication(page,profile,bank,'YCombinator')).missing.some(field=>field.id==='city_current'));
  await fixture({ambiguous:true});
  assert.ok((await fillApplication(page,profile,bank,'YCombinator')).missing.some(field=>field.id==='city_current'));
  await fixture({badPhone:true});
  assert.ok((await fillApplication(page,profile,bank,'YCombinator')).missing.some(field=>field.type==='tel'));
  assert.equal(await page.evaluate(()=>window.submitted||false),false);
  assert.equal(network,0);
  console.log('PASS: YC formatted phone, dialing-code selection, generated React Select classes, current-location region matching, plain-text required radio labels, approved answers, missing US-specific answers, rejected/ambiguous cities, wrong digits, reruns, and zero model calls/network/submission.');
} finally { await browser.close(); }
