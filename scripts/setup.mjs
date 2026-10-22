import { copyFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
// Exclusive copies preserve every existing local setting. Notion is opt-in.
for (const directory of ['config','data','resumes','output']) await mkdir(directory,{recursive:true});
for (const name of ['profile','answers']) {
  const destination=`config/${name}.json`;
  try { await copyFile(`config/${name}.example.json`,destination,constants.COPYFILE_EXCL);await chmod(destination,0o600);console.log(`Created ${destination}`); }
  catch(error){if(error.code!=='EEXIST')throw error;console.log(`Kept ${destination}`);}
}
try{await writeFile('data/jobs.txt','# One employer application URL per line.\n',{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
console.log('Edit config/profile.json and config/answers.json using your verified details. Add your resume, then run npm run dashboard. Notion is optional: see docs/NOTION.md.');
