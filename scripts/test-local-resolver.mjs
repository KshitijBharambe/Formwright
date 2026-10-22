import assert from 'node:assert/strict';
import { LocalAnswerResolver, checkLMStudio } from '../dist/local-resolver.js';
import { defaultAutofillSettings, validateAutofillSettings, loadAutofillSettings } from '../dist/autofill-settings.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = {firstName:'Alex',lastName:'Example',fullName:'Alex Example',email:'alex@fixture.test',phone:'5555550100',city:'Albany',state:'NY',linkedin:'https://linkedin.com/in/example',github:'https://github.com/example',website:'https://example.test',resumePath:import.meta.filename};
const settings = {...defaultAutofillSettings,mode:'llm',model:'fixture-chat'};
const field = (label, extra={}) => ({key:'0',label,kind:'text',required:true,...extra});
const originalFetch = globalThis.fetch;
let requests=[], output, behavior;
const reset=()=>{requests=[];output=undefined;behavior=undefined;};
globalThis.fetch=async (url, options={})=>{
  requests.push({url,options});
  if(behavior) return behavior(url,options);
  if(String(url).endsWith('/models')) return Response.json({data:[{id:'fixture-chat'}]});
  const body=JSON.parse(options.body), input=JSON.parse(body.messages[1].content);
  assert.ok(!options.body.includes(profile.email),'Never send approved answer values to the model');
  assert.ok(!options.body.includes(profile.github),'Never send profile URLs to the model');
  const id=input.candidates.find(candidate=>candidate.question==='GitHub')?.id ?? input.candidates[0]?.id;
  return Response.json({choices:[{finish_reason:'stop',message:{content: output ?? JSON.stringify({status:'matched',matchedAnswerId:id})}}]});
};
try {
  for(const baseUrl of ['https://remote.example/v1','http://192.168.1.2:1234/v1','http://localhost:1234/admin','http://user:secret@localhost:1234/v1','http://localhost:1234/v1?key=secret']) assert.throws(()=>validateAutofillSettings({...settings,baseUrl}));
  assert.throws(()=>validateAutofillSettings({...settings,mode:'invalid'}));
  assert.throws(()=>validateAutofillSettings({...settings,maxCalls:0}));
  assert.throws(()=>validateAutofillSettings({...settings,timeoutMs:0}));
  const temp=await mkdtemp(path.join(tmpdir(),'formwright-llm-config-')),previous=process.cwd();
  try {
    process.chdir(temp);await mkdir('config');
    assert.equal((await loadAutofillSettings()).mode,'deterministic');
    await writeFile('config/autofill.json',JSON.stringify(settings));
    assert.equal((await loadAutofillSettings(new Set(['--autofill=deterministic']))).mode,'deterministic');
    const cli=await loadAutofillSettings(new Set(['--lmstudio-url=http://localhost:7777/v1','--lmstudio-model=other']));
    assert.equal(cli.baseUrl,'http://localhost:7777/v1');assert.equal(cli.model,'other');
  } finally {process.chdir(previous);await rm(temp,{recursive:true,force:true});}
  let resolver=new LocalAnswerResolver(defaultAutofillSettings,profile,{});
  assert.equal(await resolver.resolve(field('Your code hosting profile')),undefined);assert.equal(requests.length,0,'Off means zero network traffic');
  resolver=new LocalAnswerResolver(settings,profile,{});
  assert.equal(await resolver.resolve(field('Your code hosting profile')),profile.github);
  assert.equal(requests.length,1);assert.equal(resolver.report.calls,1);assert.equal(resolver.report.events[0].status,'matched');
  await resolver.resolve(field('Your code hosting profile'));assert.equal(requests.length,1,'Cache decisions within one application');
  assert.equal(JSON.stringify(resolver.report).includes(profile.github),false,'Audit report excludes answer values');
  assert.equal(JSON.parse(requests[0].options.body).response_format.type,'json_schema');
  assert.equal(requests[0].options.redirect,'error');
  reset();
  const critical=[
    'Are you legally authorized to work?','Will you need visa sponsorship?', 'What is your citizenship?',
    'Preferred city for relocation','Which city are you willing to commute to?', 'Desired salary and phone number',
    'Email for marketing consent','Gender and full name','Veteran name','Date of birth and name',
    'Previous employer phone','University email','Reference phone','Emergency contact name','Supervisor name',
    'Recruiter email','Country','Write why you want this job','Password','What is your name if you are not a citizen?',
    'School city','Preferred name','Your secret email token','I agree to share my email',
    'Name on your work permit','Postal code for desired employment location'
  ];
  resolver=new LocalAnswerResolver(settings,profile,{});
  for(const label of critical) assert.equal(await resolver.resolve(field(label)),undefined,label);
  assert.equal(requests.length,0,'Critical and unsupported questions never reach the model');
  await resolver.resolve(field('Email',{context:'Immigration and employment authorization'}));
  await resolver.resolve(field('Email',{kind:'checkbox'}));
  await resolver.resolve(field('Email',{kind:'password'}));
  assert.equal(requests.length,0);
  reset();resolver=new LocalAnswerResolver(settings,profile,{'Email':'a@fixture.test','E-mail':'b@fixture.test'});
  assert.equal(await resolver.resolve(field('Your electronic mail')),undefined,'Conflicting bank entries exclude the profile fallback');
  assert.equal(requests.length,0);
  for(const result of [
    {status:'matched',matchedAnswerId:'made-up-id'},
    {status:'matched',matchedAnswerId:'answer_0',value:'invented'},
    {status:'ambiguous',matchedAnswerId:'answer_0'},
    {status:'unanswerable'},null
  ]) {
    reset();output=JSON.stringify(result);resolver=new LocalAnswerResolver(settings,profile,{});
    assert.equal(await resolver.resolve(field('Your code hosting profile')),undefined);
    assert.equal(resolver.report.events[0].status,'error');
  }
  for(const status of ['ambiguous','unanswerable']) {
    reset();output=JSON.stringify({status,matchedAnswerId:null});resolver=new LocalAnswerResolver(settings,profile,{});
    assert.equal(await resolver.resolve(field('Your code hosting profile')),undefined);assert.equal(resolver.report.events[0].status,status);
  }
  reset();output='not json';resolver=new LocalAnswerResolver(settings,profile,{});
  assert.equal(await resolver.resolve(field('Your code hosting profile')),undefined);
  await resolver.resolve(field('Professional networking profile'));assert.equal(requests.length,1,'Malformed responses trip the per-application circuit breaker');
  reset();resolver=new LocalAnswerResolver(settings,profile,{});
  assert.equal(await resolver.resolve(field('Your code hosting profile',{kind:'select',options:['Unrelated','Unknown']})),undefined);
  assert.equal(resolver.report.events[0].status,'unanswerable');
  reset();resolver=new LocalAnswerResolver({...settings,maxCalls:1},profile,{});
  await resolver.resolve(field('Your code hosting profile'));await resolver.resolve(field('Your professional networking profile'));
  assert.equal(requests.length,1);assert.equal(resolver.report.events[1].status,'budget');
  reset();resolver=new LocalAnswerResolver({...settings,model:''},profile,{});
  await resolver.resolve(field('Your code hosting profile'));assert.equal(requests.length,2);assert.equal(resolver.report.model,'fixture-chat');
  reset();behavior=async()=>Response.json({data:[{id:'one'},{id:'two'}]});
  resolver=new LocalAnswerResolver({...settings,model:''},profile,{});
  assert.equal(await resolver.resolve(field('Your code hosting profile')),undefined);assert.equal(resolver.report.calls,0);
  await assert.rejects(checkLMStudio(settings),/not available/);
  reset();behavior=async(url)=>String(url).endsWith('/api/v1/models')
    ? Response.json({models:[{type:'embedding',loaded_instances:[{id:'embedding'}]},{type:'llm',loaded_instances:[{id:'loaded-chat'}]}]})
    : Response.json({data:[{id:'loaded-chat'},{id:'downloaded-chat'},{id:'embedding'}]});
  assert.equal((await checkLMStudio({...settings,model:''})).selectedModel,'loaded-chat','Prefer the sole loaded chat model over downloaded/JIT entries');
  reset();behavior=async()=>Response.json({choices:[{finish_reason:'stop',message:{content:'',reasoning_content:'{"status":"matched","matchedAnswerId":"answer_0"}'}}]});
  resolver=new LocalAnswerResolver(settings,profile,{});
  assert.equal(await resolver.resolve(field('Your code hosting profile')),undefined,'Require a final answer, even if another channel contains JSON');
  assert.match(resolver.report.events[0].reason,/no final JSON/);
  reset();behavior=async()=>new Response('internal details',{status:500});resolver=new LocalAnswerResolver(settings,profile,{});
  assert.equal(await resolver.resolve(field('Your code hosting profile')),undefined);assert.match(resolver.report.events[0].reason,/HTTP 500/);
  reset();behavior=async()=>Response.json({choices:[{finish_reason:'length',message:{content:'{}'}}]});resolver=new LocalAnswerResolver(settings,profile,{});
  assert.equal(await resolver.resolve(field('Your code hosting profile')),undefined);
  reset();behavior=async(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))));
  resolver=new LocalAnswerResolver({...settings,timeoutMs:100},profile,{});
  const started=Date.now();assert.equal(await resolver.resolve(field('Your code hosting profile')),undefined);
  assert.ok(Date.now()-started<1000);assert.match(resolver.report.events[0].reason,/timed out/);
  console.log('PASS: LLM off/no traffic; CLI configuration; candidate privacy, schema/ID validation, abstention, conflict handling, 26 critical/unsupported prompts, option checks, cache/budget, model discovery, HTTP/truncation/timeout failures. Mock contract tests; not a model accuracy benchmark.');
} finally {globalThis.fetch=originalFetch;}
