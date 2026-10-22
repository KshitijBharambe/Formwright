import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fieldAnswer } from '../dist/profile-values.js';
import { LocalAnswerResolver } from '../dist/local-resolver.js';
import { loadAutofillSettings } from '../dist/autofill-settings.js';

// Deliberately fictional. This command never opens application sites.
const profile={firstName:'Alex',lastName:'Example',fullName:'Alex Example',email:'alex@fixture.test',phone:'5555550100',city:'Albany',state:'NY',postalCode:'12207',linkedin:'https://linkedin.com/in/example',github:'https://github.com/example',website:'https://example.test',resumePath:'fixture.pdf'};
const args=new Set(process.argv.slice(2));
const settings={...await loadAutofillSettings(args),mode:'llm'};
const limitArg=[...args].find(arg=>arg.startsWith('--limit='));
const limit=limitArg ? Number(limitArg.slice(8)) : Infinity;
if(!(limit>0)) throw Error('--limit must be positive.');
const fixture=JSON.parse(await readFile(new URL('fixtures/contact-mapping.json',import.meta.url),'utf8'));
const cases=fixture.cases.slice(0,limit),rows=[];
for(const item of cases){
  const field={key:'0',label:item.label,kind:'text',required:true};
  const direct=fieldAnswer(field,profile,{});
  const resolver=new LocalAnswerResolver(settings,profile,{});
  const started=performance.now();
  const assisted=direct ?? await resolver.resolve(field);
  const expected=item.expectedKey ? profile[item.expectedKey] : undefined;
  rows.push({...item,deterministic:direct===expected?'correct':direct===undefined?'abstained':'incorrect',llm:assisted===expected?'correct':assisted===undefined?'abstained':'incorrect',latencyMs:Math.round(performance.now()-started),report:resolver.report});
  console.log(`${rows.length}/${cases.length}: ${item.label} — deterministic ${rows.at(-1).deterministic}; LLM ${rows.at(-1).llm}`);
}
const summary={};
for(const mode of ['deterministic','llm']){
  summary[mode]={};
  for(const slice of ['all',...new Set(rows.map(row=>row.slice))]){
    const subset=rows.filter(row=>slice==='all'||row.slice===slice);
    summary[mode][slice]={total:subset.length,...Object.fromEntries(['correct','incorrect','abstained'].map(outcome=>[outcome,subset.filter(row=>row[mode]===outcome).length]))};
  }
}
const latencies=rows.filter(row=>row.report.calls).map(row=>row.latencyMs).sort((a,b)=>a-b);
const report={fixtureVersion:fixture.version,description:fixture.description,recordedAt:new Date().toISOString(),settings,summary,p95InferenceMs:latencies[Math.ceil(latencies.length*.95)-1]??null,rows};
await mkdir('output',{recursive:true});
const target=`output/llm-eval-${Date.now()}.json`;await writeFile(target,JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({summary,p95InferenceMs:report.p95InferenceMs,report:target},null,2));
if(rows.some(row=>row.llm==='incorrect')) process.exitCode=1;
else if(rows.some(row=>row.report.events.some(event=>event.status==='error'))) process.exitCode=2;
