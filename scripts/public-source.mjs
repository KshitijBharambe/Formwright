import { readdir, readFile, mkdir, copyFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root=process.cwd();
const roots=['src','web','scripts','docs','.github'];
const top=['README.md','README.txt','LICENSE','CONTRIBUTING.md','SECURITY.md','THIRD_PARTY_NOTICES.md','package.json','package-lock.json','tsconfig.json','.gitignore','DESIGN.md'];
const files=[...top];
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error(`Symlinks are not allowed in public source: ${file}`);if(entry.isDirectory())await walk(file);else files.push(file);}}
for(const dir of roots)await walk(dir);
for(const file of await readdir('config'))if(file.endsWith('.example.json'))files.push('config/'+file);
files.push('data/jobs.example.txt');
const forbidden=/(^|\/)(node_modules|output|resumes|\.browser|\.env[^/]*|\.mcp[^/]*|\.playwright-cli)(\/|$)|^config\/(?![^/]+\.example\.json$)|^data\/(?!jobs\.example\.txt$)|\.(pdf|docx|pem|p12|pfx|key|log|bak|backup)$/i;
function inspect(file,text){
  if(forbidden.test(file))throw Error(`Private file in public source: ${file}`);
  // Never echo matched values. Fixtures may contain explicitly fictional tokens.
  const suspicious=[/\b(?:ntn_|secret_)[A-Za-z0-9]{25,}/,/\bgh[pousr]_[A-Za-z0-9]{30,}/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\/Users\/[A-Za-z0-9_-]+\//];
  if(suspicious.some(pattern=>pattern.test(text)))throw Error(`Potential credential or personal machine path in ${file}; review locally.`);
  if(file.startsWith('config/') && file.endsWith('.example.json')){
    const config=JSON.parse(text);
    for(const key of ['token','password','databaseId','dataSourceId'])if(config[key])throw Error(`Example must not contain a real ${key}: ${file}`);
  }
}
for(const file of files){if(!(await lstat(file)).isFile())throw Error(`Expected regular source file: ${file}`);inspect(file,await readFile(file,'utf8'));}
// .gitignore does not protect already tracked files. Check the index too.
let tracked=[];
try{tracked=execFileSync('git',['ls-files','-z'],{cwd:root,stdio:['ignore','pipe','ignore']}).toString().split('\0').filter(Boolean);}catch(error){if(error.status!==128)throw error;}
for(const file of tracked){if(forbidden.test(file))throw Error(`Private file is tracked by Git: ${file}`);let text;try{text=await readFile(file,'utf8');}catch{throw Error(`Tracked file unavailable for inspection: ${file}`);}inspect(file,text);}
console.log(`PASS: ${files.length} allowlisted public files inspected; ${tracked.length} tracked files checked. No personal data is copied from local config or output.`);
if(process.argv.includes('--export')){
  const destination=path.join(root,'output','public-source-'+new Date().toISOString().replace(/[:.]/g,'-'));
  await mkdir(destination,{recursive:true});
  for(const file of files){const target=path.join(destination,file);await mkdir(path.dirname(target),{recursive:true});await copyFile(file,target);}
  console.log(`Public source ready for review: ${destination}`);
}
