import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fillApplication } from '../dist/form.js';
const profile={firstName:'Alex',lastName:'Example',fullName:'Alex Example',email:'alex@example.com',phone:'5555550100',resumePath:import.meta.filename};
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage(); page.setDefaultTimeout(600);
 await page.route('**/*',route=>route.abort());
 await page.setContent(`<form id="application-form">
 <div class="file-upload"><label for="resume">Resume *</label><input type="file" id="resume" required></div>
 <label for="first_name">First Name *</label><input id="first_name" required>
 <label for="last_name">Last Name *</label><input id="last_name" required>
 <label for="email">Email *</label><input id="email" type="email" required>
 <button type="button" onclick="window.submitted=true">Submit application</button></form>`);
 await page.locator('#resume').evaluate(el=>el.addEventListener('change',()=>{
   const form=el.closest('form'); const copy=form.cloneNode(true);
   copy.removeAttribute('data-ap-scope');
   copy.querySelectorAll('*').forEach(node=>{for(const attr of [...node.attributes])if(attr.name.startsWith('data-ap-'))node.removeAttribute(attr.name);});
   const attachment=document.createElement('div'); attachment.id='resume'; attachment.textContent=el.files[0].name;
   copy.querySelector('input[type=file]').replaceWith(attachment); form.replaceWith(copy);
 }));
 const result=await fillApplication(page.mainFrame(),profile,{},'Greenhouse');
 assert.equal(await page.locator('#first_name').inputValue(),'Alex');
 assert.equal(await page.locator('#email').inputValue(),profile.email);
 assert.equal(result.resumeUploaded,true);
 assert.equal(await page.evaluate(()=>window.submitted||false),false);
 assert.deepEqual(result.missing,[]);
 console.log('PASS: upload-triggered form replacement retains verified attachment and fills remaining fields without submitting.');
 // A rejected upload still fills identity fields, and another attachment's
 // matching filename must never establish resume acceptance.
 await page.setContent(`<form id="application-form"><div class="file-upload"><label for="resume">Resume *</label><input id="resume" type="file" required></div>
 <div class="file-upload"><label>Cover letter</label><span>${import.meta.filename.split('/').pop()}</span></div>
 <label for="first_name">First Name *</label><input id="first_name" required><label for="last_name">Last Name *</label><input id="last_name" required>
 <label for="email">Email *</label><input id="email" type="email" required></form>`);
 await page.locator('#resume').evaluate(el=>el.addEventListener('change',()=>{
   el.parentElement.innerHTML='<label>Resume *</label><div role="alert">Upload rejected</div>';
 }));
 const failed=await fillApplication(page.mainFrame(),profile,{},'Greenhouse');
 assert.equal(failed.resumeUploaded,false);
 assert.equal(await page.locator('#email').inputValue(),profile.email);
 assert.ok(failed.missing.some(field=>field.type==='file'));
 console.log('PASS: rejected/removed resume input does not abort factual filling or accept another attachment filename.');

} finally {await browser.close();}
