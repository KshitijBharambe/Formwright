import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fillApplication } from '../dist/form.js';
import { applicationCountry } from '../dist/job-context.js';
const profile={ firstName:'Alex',lastName:'Example',fullName:'Alex Example',email:'alex@example.com',phone:'5555550100',resumePath:import.meta.filename };
const bank={
 'Will you now or in the future require employment sponsorship?':'Yes, I will require sponsorship in the future.',
 'Are you legally authorized to work in the United States?':'Yes. I am authorized to work in the United States.',
 'What is your LinkedIn URL?':'https://example.com/alex',
 'What degree do you hold?':'Master of Science in Computer Science (Example University, May 2025) and Bachelor of Engineering in Computer Engineering (Example Institute, May 2023).'
};
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage(); page.setDefaultTimeout(1200);
 // No data may leave the fixture: even accidental requests are aborted.
 let requests=0; await page.route('**/*',route=>{requests++;return route.abort();});
 const widget=(id,label,required=false)=>`<div class="select__container"><label for="${id}">${label}${required?'*':''}</label><div class="select__control"><span class="select__placeholder">Select...</span><input id="${id}" role="combobox" aria-expanded="false" aria-required="${required}"></div></div>`;
 await page.setContent(`<div class="job__location">New York City</div><form id="application-form">
 <div class="file-upload"><label for="resume">Resume *</label><input id="resume" type="file" required></div>
 <label for="first_name">First Name*</label><input id="first_name" required>
 <label for="last_name">Last Name*</label><input id="last_name" required>
 <label for="email">Email*</label><input id="email" required>
 <div class="education--container"><div class="education--form">${widget('school--0','School')}${widget('degree--0','Degree')}</div><button type="button" id="add">Add another</button></div>
 ${widget('source','How did you initially hear about this job?',true)}
 ${widget('authorization','Are you legally authorized to work in the country where this job is located?',true)}
 ${widget('sponsorship','Will you now or in the future require visa sponsorship?',true)}
 <label for="linkedin">LinkedIn Profile</label><input id="linkedin">
 ${widget('newsletter','Select ‘Yes’ to join Braze’s Talent Community and receive newsletters.',true)}
 ${widget('commute','Will you be able to regularly commute and work in an office in job posting location?')}
 <button type="button" id="submit">Submit application</button></form>`);
 await page.evaluate(()=>{
  document.querySelector('#submit').onclick=()=>window.didSubmit=true;
  const install=input=>{
   const open=()=>{
    document.querySelectorAll('[role=listbox]').forEach(el=>el.remove());
    const id=input.id;
    const choices=id.startsWith('school--')?['Example University','Example Institute']:
     id.startsWith('degree--')?["Bachelor's Degree","Master's Degree"]:['Yes','No'];
    const menu=document.createElement('div');menu.id='menu';menu.setAttribute('role','listbox');
    for(const value of choices){const option=document.createElement('div');option.setAttribute('role','option');option.textContent=value;
     option.onclick=()=>{const control=input.closest('.select__control');control.querySelector('.select__placeholder')?.remove();control.querySelector('.select__single-value')?.remove();const selected=document.createElement('span');selected.className='select__single-value';selected.textContent=value;control.prepend(selected);input.value='';input.setAttribute('aria-expanded','false');menu.remove();};menu.append(option);}
    input.setAttribute('aria-controls','menu');input.setAttribute('aria-expanded','true');input.closest('.select__container').append(menu);
   };
   input.addEventListener('click',open);input.addEventListener('input',open);
  };
  document.querySelectorAll('[role=combobox]').forEach(install);
  document.querySelector('#add').onclick=()=>{
   const forms=document.querySelectorAll('.education--form'); const copy=forms[0].cloneNode(true);
   copy.querySelectorAll('[id]').forEach(el=>el.id=el.id.replace('--0',`--${forms.length}`));
   copy.querySelectorAll('label[for]').forEach(el=>el.htmlFor=el.htmlFor.replace('--0',`--${forms.length}`));
   copy.querySelectorAll('[role=combobox]').forEach(install);document.querySelector('#add').before(copy);
  };
  document.querySelector('#resume').onchange=event=>{
   const input=event.target;const span=document.createElement('span');span.textContent=input.files[0].name;input.closest('.file-upload').append(span);
  };
 });
 const result=await fillApplication(page.mainFrame(),profile,bank,'Greenhouse');
 const selected=id=>page.locator(`[id="${id}"]`).evaluate(el=>el.closest('.select__control').querySelector('.select__single-value')?.textContent);
 assert.equal(await selected('authorization'),'Yes');
 assert.equal(await selected('sponsorship'),'Yes');
 assert.equal(await selected('school--0'),'Example University');
 assert.equal(await selected('degree--0'),"Master's Degree");
 assert.equal(await selected('school--1'),'Example Institute');
 assert.equal(await selected('degree--1'),"Bachelor's Degree");
 assert.equal(await page.locator('#linkedin').inputValue(),bank['What is your LinkedIn URL?']);
 assert.equal(result.resumeUploaded,true);
 assert.deepEqual(result.missing.map(f=>f.id).sort(),['newsletter','source']);
 assert.equal(await selected('commute'),undefined);
 assert.equal(await page.evaluate(()=>window.didSubmit||false),false);
 assert.equal(requests,0);
 await page.locator('.job__location').evaluate(el=>el.textContent='Toronto, Canada');
 assert.equal(await applicationCountry(page.mainFrame()),undefined);
 await page.setContent('<script type="application/ld+json">{"@type":"JobPosting","jobLocation":[{"address":{"addressCountry":"US"}},{"address":{"addressCountry":"CA"}}]}</script>');
 assert.equal(await applicationCountry(page.mainFrame()),undefined);
 console.log('PASS: offline Braze-style form fills authorization, sponsorship, LinkedIn, both education rows and resume; source, newsletter and commute remain unanswered; no network requests or submission.');
}finally{await browser.close();}
