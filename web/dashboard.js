const $ = id => document.getElementById(id);
let state, busy = false, polling, fingerprint = '', autofillDirty = false, accountDirty = false;
let collection = 'all', currentView = 'applications', pageIndex = 0;
const pageSize = 50, pendingRows = new Map(), rowCache = new Map(), viewSignatures = new Map();
let lastSourceSync = Date.now(), syncing = false, feedbackTimer;
const dateFormatter = new Intl.DateTimeFormat(undefined, {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});
const expanded = new Set(), questionPanels = new Set(), rowFeedback = new Map(), drafts = new Map();
const names = {not_started:'Not started', queued:'Queued', running:'Autofilling', ready_for_review:'Ready for review', needs_answers:'Needs information', needs_verification:'Verify submission', submitted:'Submitted', error:'Error', interrupted:'Interrupted', skipped:'Skipped', done:'Finished'};
const el = (tag, text, cls) => { const node = document.createElement(tag); if(text !== undefined) node.textContent = text; if(cls) node.className = cls; return node; };
const time = value => value ? dateFormatter.format(new Date(value)) : '—';
const link = (value, text, cls) => { const node = el('a', text, cls); try { const url = new URL(value); if(!['https:','http:'].includes(url.protocol)) return el('span',text,cls); node.href = url.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; } catch { return el('span',text,cls); } return node; };
const status = job => ['submitted','needs_verification'].includes(job.blockedReason) ? job.blockedReason : ['queued','running','interrupted','error'].includes(job.task?.state) ? job.task.state : job.result?.status || (job.task?.state === 'done' ? 'done' : 'not_started');
function empty(body, columns, text) { const row=el('tr'), cell=el('td',text,'empty');cell.colSpan=columns;row.append(cell);body.append(row); }
function error(id, text) { $(id).textContent=text || '';$(id).hidden=!text; }
async function getState() { const response=await fetch('/api/state'); if(!response.ok) throw Error('Could not read dashboard state.');return response.json(); }
async function refresh() {
  if(polling) return polling;
  polling=(async()=>{
    try { state=await getState();error('connection','');render(); }
    catch(err) { error('connection','Connection lost. Restart npm run dashboard if needed. '+err.message); }
  })().finally(()=>{polling=undefined;});
  return polling;
}
async function command(route, body={}, rowUrl) {
  if(busy || (rowUrl && pendingRows.has(rowUrl))) return;
  if(rowUrl) { pendingRows.set(rowUrl,route); rowFeedback.set(rowUrl,{message:route==='tracking' ? 'Saving…' : 'Updating…'}); }
  else { busy=true; clearTimeout(feedbackTimer); $('feedback').textContent='Working…'; }
  fingerprint='';
  render();
  let completedMessage;
  try {
    const response=await fetch('/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Formwright-Token':document.querySelector('meta[name="formwright-token"]').content},body:JSON.stringify(body)});
    const result=await response.json();if(!response.ok) throw Error(result.error || 'Command failed.');
    const message=result.message || (route==='add' ? result.added+' new link(s) saved. '+result.queued+' added to the queue.' : (result.queued ?? 0)+' added to the queue. Use Run queue when ready.');
    completedMessage=message;
    if(route==='add') error('add-error','');
    if(route==='add') { $('urls').value=''; $('add-box').hidden=true; }
    if(route==='settings' && body.autofill) autofillDirty=false;
    if(route==='account') { accountDirty=false; $('account-password').value=''; }
    if(route==='lmstudio/check') {
      $('lmstudio-status').textContent=result.message+' Connection check only; use eval:llm to test mappings.';
      $('lmstudio-models').replaceChildren(...result.models.map(model=>{const option=el('option');option.value=model;return option;}));
      if(!$('lmstudio-model').value && result.selectedModel){$('lmstudio-model').value=result.selectedModel;autofillDirty=true;}
    }
  } catch(err) { if(rowUrl) rowFeedback.set(rowUrl,{message:err.message,error:true}); else if(route==='add') { error('add-error',err.message); $('feedback').textContent=''; } else $('feedback').textContent=err.message; if(route==='lmstudio/check') $('lmstudio-status').textContent=err.message; }
  finally {
    // Let an earlier poll finish, then read state committed by this command.
    if(polling) await polling;
    if(rowUrl) pendingRows.delete(rowUrl); else busy=false;fingerprint='';await refresh();
    if(completedMessage){if(rowUrl){if(route==='selection')rowFeedback.delete(rowUrl);else rowFeedback.set(rowUrl,{message:completedMessage});renderApplications();}else { $('feedback').textContent=completedMessage; feedbackTimer=setTimeout(()=>{$('feedback').textContent='';},7000); }}
  }
}
function render() {
  if(!state) return;
  const signature=JSON.stringify([state.applications,state.worker,state.notion,state.file,state.answers,state.config,busy,[...pendingRows],[...rowFeedback]]);
  if(signature===fingerprint) return;fingerprint=signature;
  const worker=state.worker;
  document.querySelector('.worker').dataset.running=String(worker.running);
  $('sync-state').textContent=syncing ? 'Syncing…' : state.notion.error ? 'Sync needs attention' : state.notion.fetchedAt ? 'Synced '+time(state.notion.fetchedAt) : 'Local sources';
  const failed=[['Notion jobs',state.notion],['Answers',state.answers],['Configuration',state.config],['File URLs',state.file]].filter(([,source])=>source.error).map(([name])=>name);
  error('source-warning',failed.length ? 'Refresh failed for: '+failed.join(', ')+'. Open the corresponding view for details; displayed snapshots may be stale.' : '');
  $('worker-status').textContent=worker.active.length ? 'Autofilling '+worker.active.length+' applications' : worker.queued ? worker.queued+' selected'+(worker.paused ? ' · Paused' : '') : 'Select jobs to autofill';
  $('worker-detail').textContent=worker.error ? 'Queue paused. Open the failed application’s details to retry.' : worker.active.length ? (worker.paused ? 'Finishing active applications before pausing.' : 'Tabs stay open for review.') : '';
  $('worker-detail').hidden=!$('worker-detail').textContent;
  $('start').disabled=busy || pendingRows.size>0 || !worker.queued || (!worker.paused && worker.running);
  $('start').textContent=worker.queued ? 'Run queue · '+worker.queued : 'Run queue';
  $('pause').hidden=!worker.running;
  $('pause').disabled=busy || worker.paused || !worker.running;

  $('concurrency').value=worker.concurrency;$('concurrency').disabled=busy || worker.running;
  $('advance').checked=worker.advance;$('advance').disabled=busy || worker.running;
  if(!autofillDirty){$('autofill-mode').value=worker.autofill.mode;$('lmstudio-url').value=worker.autofill.baseUrl;$('lmstudio-model').value=worker.autofill.model;}
  document.querySelectorAll('#autofill-form input,#autofill-form select,#autofill-form button').forEach(node=>node.disabled=busy || worker.running);
  document.querySelectorAll('[data-refresh],#add-form button').forEach(node=>node.disabled=busy || (node.hasAttribute('data-refresh') && syncing) || (node.closest('#add-form') && worker.running));
  $('app-count').textContent=state.applications.filter(job=>!job.removed).length;$('notion-count').textContent=state.notion.data.length;
  renderActiveView();
  error('config-error',state.config.error);
  $('profile').textContent=JSON.stringify(state.config.data.profile || {},null,2);
  $('notion-config').textContent=JSON.stringify(state.config.data.notion || {},null,2);
  $('token-state').textContent='Notion token: '+(state.config.data.notionTokenConfigured ? 'configured (hidden)' : 'not configured');
  const account=state.config.data.account || {};
  if(!accountDirty){$('account-enabled').checked=!!account.enabled;$('account-signup').checked=!!account.allowSignup;$('account-username').value=account.username || '';$('account-hosts').value=(account.allowedHosts || []).join('\n');}
  const loginState=account.enabled && account.passwordConfigured ? 'Automatic login enabled' : account.passwordConfigured ? 'Automatic login disabled — enable in Configuration' : 'Login credentials missing — save in Configuration';

  $('account-state').textContent=account.message || loginState;
  document.querySelectorAll('#account-form input,#account-form textarea,#account-form button').forEach(node=>node.disabled=busy || worker.running);
  $('file-state').textContent=state.file.error || state.file.data.length+' file URLs loaded · '+time(state.file.fetchedAt);
}
const complete = job => ['Applied','Rejected','Closed'].includes(job.tracking?.status) || job.tracking?.lifecycle==='Archived' || status(job)==='submitted';
const attention = job => ['error','interrupted','needs_answers','needs_verification'].includes(status(job)) && !complete(job) && !job.removed;
function visibleJobs() {
  const query=$('search').value.toLowerCase(), filter=$('status').value;
  return state.applications.filter(job=>
    (collection==='removed' ? job.removed : !job.removed) &&
    (collection!=='queue' || ['queued','running'].includes(job.task?.state)) &&
    (collection!=='attention' || attention(job)) && (collection!=='completed' || complete(job)) &&
    (!filter || status(job)===filter) && JSON.stringify([job.url,job.notion?.title,job.notion?.company,job.sources,job.tracking?.status,status(job)]).toLowerCase().includes(query));
}
function showCollection(value) {
  collection=value; pageIndex=0; $('search').value=''; $('status').value=''; renderApplications();
}
function rowButton(text, handler, disabled=false) {
  const node=el('button',text); node.type='button';node.disabled=busy || disabled;node.addEventListener('click',handler);return node;
}
function renderApplications() {
  if(!state) return;
  const body=$('application-rows'),active=document.activeElement,focus=body.contains(active) ? active.dataset.focus : undefined;
  const caret=focus && ['INPUT','TEXTAREA'].includes(active.tagName) ? [active.selectionStart,active.selectionEnd] : null;
  const openDetails=new Set([...body.querySelectorAll('details[open]')].map(node=>node.dataset.detail));
  const matches=visibleJobs();pageIndex=Math.min(pageIndex,Math.max(0,Math.ceil(matches.length/pageSize)-1));
  const jobs=matches.slice(pageIndex*pageSize,(pageIndex+1)*pageSize), locked=state.worker.running, pending=state.applications.filter(job=>job.task?.state==='queued'), eligible=jobs.filter(job=>!job.retryBlocked);
  $('filtered-count').textContent=matches.length+' matching';
  $('page-summary').textContent=matches.length ? (pageIndex*pageSize+1)+'–'+Math.min((pageIndex+1)*pageSize,matches.length)+' of '+matches.length : '0 applications';
  $('page-prev').disabled=pageIndex===0;$('page-next').disabled=(pageIndex+1)*pageSize>=matches.length;
  $('queue-count').textContent=pending.length; $('attention-count').textContent=state.applications.filter(attention).length;
  const hidden=pending.filter(job=>!jobs.some(visible=>visible.url===job.url)).length;
  if(!state.worker.active.length && !state.worker.error){
    $('worker-detail').textContent=hidden ? hidden+' selected outside this view.' : '';
    $('worker-detail').hidden=!hidden;
  }
  $('deselect-visible').hidden=!jobs.some(job=>job.task?.state==='queued');
  $('deselect-visible').disabled=busy || locked;
  const all=eligible.length>0 && eligible.every(job=>job.task?.state==='queued');
  $('select-visible').checked=all;$('select-visible').indeterminate=!all && eligible.some(job=>job.task?.state==='queued');
  $('select-visible').disabled=busy || locked || !eligible.length;
  document.querySelectorAll('[data-collection]').forEach(node=>node.setAttribute('aria-pressed',String(collection===node.dataset.collection)));
  const desired=[];
  for(const job of jobs) {
    const rowBusy=pendingRows.has(job.url), note=rowFeedback.get(job.url);
    const signature=JSON.stringify([job,locked,busy,rowBusy,note,expanded.has(job.url),collection,pending.findIndex(item=>item.url===job.url)]);
    const cached=rowCache.get(job.url);
    if(cached?.signature===signature){desired.push(...cached.nodes);continue;}
    const nodes=[];
    const name=job.notion?.title || new URL(job.url).hostname,row=el('tr');row.className='application-row';row.dataset.url=job.url;row.dataset.selected=String(job.task?.state==='queued');
    const checkCell=el('td'),check=el('input');check.type='checkbox';check.checked=['queued','running'].includes(job.task?.state);check.disabled=busy || rowBusy || locked || (job.retryBlocked && !check.checked);
    check.dataset.focus='select:'+job.url;check.setAttribute('aria-label','Include '+name+' in autofill queue');
    check.addEventListener('change',()=>command('selection',{urls:[job.url],selected:check.checked},job.url));const checkLabel=el('label',undefined,'queue-check');checkLabel.append(check);checkCell.append(checkLabel);
    const title=el('td');if(job.notion?.company)title.append(el('div',job.notion.company,'company'));
    title.append(link(job.url,name,'title'));
    const progress=el('td');progress.append(el('span',names[status(job)] || status(job),'badge '+status(job)));
    if(job.task?.state==='queued')progress.append(el('div','Starts '+(pending.findIndex(item=>item.url===job.url)+1)+' in queue','sources'));
    const tracking=el('td');
    if(job.removed)tracking.append(el('div',job.tracking?.status || 'New','tracking-status'));
    else tracking.append(trackingSelect(job,'status','Application status for '+name));
    if(job.tracking?.lifecycle==='Archived')tracking.append(el('div','Archived','tracking-lifecycle'));
    if(note){const feedback=el('p',note.message,'row-feedback'+(note.error ? ' error-text' : ''));feedback.setAttribute('role',note.error ? 'alert' : 'status');tracking.append(feedback);}
    const actions=el('td'),group=el('div',undefined,'row-actions');
    const manage=rowButton(expanded.has(job.url) ? 'Close' : 'Details',()=>{expanded.has(job.url) ? expanded.delete(job.url) : expanded.add(job.url);renderApplications();});manage.setAttribute('aria-expanded',String(expanded.has(job.url)));manage.setAttribute('aria-label',(expanded.has(job.url) ? 'Close details for ' : 'Details for ')+name);
    manage.classList.add('detail-button');manage.dataset.focus='details:'+job.url;
    if(job.removed)group.append(rowButton('Restore',()=>command('restore',{url:job.url},job.url),rowBusy || locked));
    if(!job.removed && status(job)==='ready_for_review' && job.tracking?.statusOptions.includes('Applied') && !complete(job)){
      const applied=rowButton('Mark applied',()=>saveTracking(job,'status','Applied'),locked || rowBusy);
      applied.title='Mark Applied after you submit on the employer site';applied.classList.add('mark-applied');applied.dataset.focus='applied:'+job.url;group.append(applied);
    }
    group.append(manage);actions.append(group);row.append(checkCell,title,progress,tracking,actions);nodes.push(row);
    const auto=collection==='attention' && attention(job);
    if(expanded.has(job.url) || auto){
      const detailRow=el('tr',undefined,'row-detail');detailRow.dataset.for=job.url;
      const cell=el('td');cell.colSpan=5;const content=el('div',undefined,'detail-content');
      if(['error','interrupted'].includes(status(job))){const error=el('p',(['error','interrupted'].includes(job.task?.state) ? job.task.message : job.result?.message) || 'Autofill stopped. Review this application, then add it to the queue to retry.','error');error.setAttribute('role','alert');content.append(error);}
      if(status(job)==='needs_verification')content.append(el('p',job.result?.message || 'Review the employer page to verify whether this application was submitted. Autofill is locked to prevent duplicate submissions.','notice'));
      const modelError=job.result?.autofill?.events?.find(event=>event.status==='error');if(modelError)content.append(el('p','LM Studio: '+modelError.reason,'error'));
      if(job.questions?.length && attention(job)) renderQuestions(job,content);
      else if(status(job)==='needs_answers' && attention(job))content.append(el('p',job.result?.message || 'Additional information is needed to proceed. Open the application to complete the manual step.','notice'));
      if(job.retryBlocked && !job.removed)content.append(el('p','Autofill unavailable: '+(names[job.blockedReason] || job.blockedReason)+'.','muted'));
      if(expanded.has(job.url)) renderManagement(job,content);
      cell.append(content);detailRow.append(cell);nodes.push(detailRow);
    }
    rowCache.set(job.url,{signature,nodes});desired.push(...nodes);
  }
  // Keep unchanged rows mounted. Polls must not steal focus or rebuild inputs.
  let cursor=body.firstChild;
  for(const node of desired){if(node===cursor)cursor=cursor.nextSibling;else body.insertBefore(node,cursor);}
  while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
  for(const key of rowCache.keys())if(!jobs.some(job=>job.url===key))rowCache.delete(key);
  if(!jobs.length)empty(body,5,collection==='queue' ? 'Your queue is empty. Select jobs in All applications, then review them here before starting.' : collection==='attention' ? 'No applications need your attention right now.' : collection==='removed' ? 'Removed applications appear here. You can restore them any time.' : $('search').value || $('status').value ? 'No matches. Try another search or clear the status filter.' : 'No applications here yet. Refresh from Notion or add an application link.');
  for(const details of body.querySelectorAll('details')) if(openDetails.has(details.dataset.detail)) details.open=true;
  if(focus){const next=[...body.querySelectorAll('[data-focus]')].find(node=>node.dataset.focus===focus);if(next && !next.disabled){next.focus({preventScroll:true});if(caret && caret[0]!==null)try{next.setSelectionRange(...caret);}catch{}}}
}
function renderQuestions(job,target) {
  const panel=el('details',undefined,'questions-panel');panel.dataset.detail='questions:'+job.url;panel.open=questionPanels.has(job.url);
  panel.append(el('summary','Additional information needed · '+job.questions.length+' item'+(job.questions.length===1 ? '' : 's')),el('p','Answer the questions below to continue. Answers are saved only for this application.','muted'));
  panel.addEventListener('toggle',()=>{panel.open ? questionPanels.add(job.url) : questionPanels.delete(job.url);});
  const form=el('form'),inputs=[];form.setAttribute('aria-label','Additional information for '+(job.notion?.title || job.url));
  for(const question of job.questions){
    const field=el('fieldset'),legend=el('legend',question.label);field.append(legend);
    if(question.context)field.append(el('p',question.context,'muted'));
    if(!question.canAnswer){field.append(el('p',question.reason,'muted'));if(question.options?.length)field.append(el('p','Options: '+question.options.join(' · '),'muted'));form.append(field);continue;}
    const key=job.url+':'+job.result.timestamp+':'+question.index, label=el('label',question.options?.length ? 'Your selection' : 'Your answer');
    let input;
    const multiple=['checkbox','select-multiple'].includes(question.type) && question.options?.length>1;
    if(question.options?.length){input=el('select');input.multiple=!!multiple;if(!multiple){const option=el('option','Choose an answer');option.value='';input.append(option);}for(const value of question.options){const option=el('option',value);option.value=value;input.append(option);}}
    else input=el('textarea');
    input.dataset.focus=key;input.disabled=busy || state.worker.running || pendingRows.has(job.url) || job.retryBlocked;input.setAttribute('aria-label',question.label);input.maxLength=20000;
    const draft=drafts.get(key) || '';
    if(multiple){let values=[];try{values=JSON.parse(draft);}catch{}for(const option of input.options)option.selected=values.includes(option.value);field.append(el('p','Select every option that applies. Use Ctrl or Command to select more than one.','muted'));}
    else input.value=draft;
    input.addEventListener('input',()=>drafts.set(key,multiple ? JSON.stringify([...input.selectedOptions].map(option=>option.value)) : input.value));
    label.append(input);field.append(label);form.append(field);inputs.push({question,input,multiple});
  }
  if(inputs.length){const save=el('button','Save answers & queue retry');save.type='submit';save.disabled=busy || state.worker.running || pendingRows.has(job.url) || job.retryBlocked;form.append(save,el('p','Leave unknown answers blank. Use Run queue when you’re ready to retry.','muted'));}
  form.addEventListener('submit',event=>{event.preventDefault();const answers=inputs.map(({question,input,multiple})=>({index:question.index,label:question.label,resultTimestamp:job.result.timestamp,value:multiple ? JSON.stringify([...input.selectedOptions].map(option=>option.value)) : input.value})).filter(answer=>answer.value.trim() && answer.value!=='[]');if(!answers.length){rowFeedback.set(job.url,{message:'Enter at least one answer before saving.',error:true});renderApplications();return;}command('answers',{url:job.url,answers},job.url);});panel.append(form);target.append(panel);
}
function renderManagement(job,target) {
  target.append(el('p',[new URL(job.url).hostname,...job.sources,time(job.task?.updatedAt || job.result?.timestamp)].join(' · '),'muted'));
  if(job.result?.message && !attention(job))target.append(el('p',job.result.message));
  target.append(link(job.url,'Open application ↗'));
  if(job.notion?.pageUrl)target.append(document.createTextNode(' · '),link(job.notion.pageUrl,'Open in Notion ↗'));
  if(!job.removed){
    const lifecycle=el('label','Lifecycle','tracking-form');lifecycle.append(trackingSelect(job,'lifecycle','Lifecycle for '+(job.notion?.title || job.url)));target.append(lifecycle,el('p',job.notion ? 'Changes save to Notion immediately and are verified. Mark Applied only after you submit on the employer site.' : 'Tracking is saved on this device. Mark Applied only after submitting.','muted'));
    const remove=el('details',undefined,'remove-control');remove.dataset.detail='remove:'+job.url;remove.append(el('summary','Remove this application…'),el('p','Remove this job from the dashboard and queue. Its Notion record and application history stay intact. You can restore it from Removed.','muted'),rowButton('Remove from dashboard',()=>command('remove',{url:job.url},job.url),state.worker.running || pendingRows.has(job.url)));target.append(remove);
  }
  if(job.result){const detail=el('details',undefined,'config-block');detail.dataset.detail='result:'+job.url;detail.append(el('summary','Autofill details & filled fields'),el('pre',JSON.stringify(job.result,null,2)));target.append(detail);}
}
function freshness(source) { return (source.error ? 'Last successful snapshot: ' : 'Fetched: ')+time(source.fetchedAt)+(source.error ? ' · Stale; the runner will not use a failed source.' : ''); }
function renderNotion() {
  $('notion-freshness').textContent=state.notion.data.length+' URLs · '+freshness(state.notion);error('notion-error',state.notion.error);
  const body=$('notion-rows');body.replaceChildren();
  for(const job of state.notion.data){const row=el('tr'), name=el('td');name.append(el('span',job.notion?.title || 'Untitled job','title'),el('span',job.notion?.company || '','muted'));const url=el('td');url.append(link(job.url,job.url));const tracking=el('td',(job.notion?.status || '—')+(job.notion?.lifecycle ? ' · '+job.notion.lifecycle : ''));const notion=el('td');if(job.notion?.pageUrl)notion.append(link(job.notion.pageUrl,'Open in Notion'));else notion.textContent=job.notion?.pageId || '—';row.append(name,url,tracking,notion);body.append(row);}
  if(!state.notion.data.length)empty(body,4,state.notion.error ? 'Could not fetch Notion jobs. See the error above.' : 'No matching Notion URLs. Check your Notion configuration/filter or add URLs manually.');
}
function renderAnswers() {
  if(!state)return;error('answers-error',state.answers.error);$('answers-freshness').textContent=freshness(state.answers);
  const query=$('answer-search').value.toLowerCase(),body=$('answer-rows');body.replaceChildren();
  const entries=(state.answers.data?.entries || []).filter(entry=>JSON.stringify(entry).toLowerCase().includes(query));
  for(const entry of entries){const row=el('tr');row.append(el('td',entry.question),el('td',entry.answer),el('td',entry.source));body.append(row);}
  if(!entries.length)empty(body,3,query ? 'No answers match this search.' : state.answers.error ? 'Answers unavailable. Resolve the source error before autofilling.' : 'No approved answers loaded. Configure the Notion Answer Bank or config/answers.json.');
}
function saveTracking(job,field,value){
  const expected=job.tracking?.[field] || '';
  if(value!==expected)command('tracking',{url:job.url,field,value,expected},job.url);
}
function trackingSelect(job,field,label){
  const select=el('select',undefined,'tracking-select tracking-status');select.setAttribute('aria-label',label);select.dataset.focus=field+':'+job.url;
  const current=job.tracking?.[field] || '', options=job.tracking?.[field==='status' ? 'statusOptions' : 'lifecycleOptions'] || [];
  if(!options.includes(current)){const option=el('option',current || 'Not set');option.value=current;select.append(option);}
  for(const value of options){const option=el('option',value);option.value=value;select.append(option);}
  select.value=current;select.disabled=busy || state.worker.running || pendingRows.has(job.url) || !options.length;
  select.addEventListener('change',()=>saveTracking(job,field,select.value));return select;
}
function renderActiveView(){
  const key=currentView==='applications' ? null : JSON.stringify(currentView==='notion' ? state.notion : state.answers);
  if(key && viewSignatures.get(currentView)===key)return;
  if(currentView==='applications')renderApplications();
  else if(currentView==='notion')renderNotion();
  else if(currentView==='answers')renderAnswers();
  if(key)viewSignatures.set(currentView,key);
}
function showView(name){
  currentView=name;
  document.querySelectorAll('[data-tab]').forEach(node=>{if(node.dataset.tab===name)node.setAttribute('aria-current','page');else node.removeAttribute('aria-current');});
  document.querySelectorAll('.view').forEach(view=>view.hidden=view.id!==name);
  $('view-name').textContent={applications:'Applications',notion:'Notion pipeline',answers:'Answers & profile',settings:'Configuration',help:'How to use'}[name];
  if(state)renderActiveView();
}
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>showView(button.dataset.tab)));
document.querySelectorAll('[data-refresh]').forEach(button=>button.addEventListener('click',()=>syncSources(false)));
$('add-form').addEventListener('submit',event=>{event.preventDefault();command('add',{urls:$('urls').value});});
$('start').addEventListener('click',()=>command('start'));$('pause').addEventListener('click',()=>command('pause'));
$('deselect-visible').addEventListener('click',()=>command('selection',{urls:visiblePage().filter(job=>job.task?.state==='queued').map(job=>job.url),selected:false}));
$('select-visible').addEventListener('change',()=>command('selection',{urls:visiblePage().filter(job=>!job.retryBlocked).map(job=>job.url),selected:$('select-visible').checked}));
document.querySelectorAll('[data-collection]').forEach(button=>button.addEventListener('click',()=>showCollection(button.dataset.collection)));
$('concurrency').addEventListener('change',()=>{const concurrency=Number($('concurrency').value);if(concurrency!==state.worker.concurrency)command('settings',{concurrency});});
$('account-form').addEventListener('input',()=>{accountDirty=true;});
$('account-form').addEventListener('submit',event=>{event.preventDefault();command('account',{enabled:$('account-enabled').checked,allowSignup:$('account-signup').checked,username:$('account-username').value,password:$('account-password').value,allowedHosts:$('account-hosts').value.split(/[\s,]+/).filter(Boolean)});});
$('advance').addEventListener('change',()=>command('settings',{advance:$('advance').checked}));
function autofillInput(){return {...state.worker.autofill,mode:$('autofill-mode').value,baseUrl:$('lmstudio-url').value,model:$('lmstudio-model').value};}
$('autofill-form').addEventListener('input',()=>{autofillDirty=true;});
$('autofill-form').addEventListener('submit',event=>{event.preventDefault();command('settings',{autofill:autofillInput()});});
$('lmstudio-check').addEventListener('click',()=>command('lmstudio/check',{autofill:autofillInput()}));
$('search').addEventListener('input',()=>{pageIndex=0;renderApplications();});$('status').addEventListener('change',()=>{pageIndex=0;renderApplications();});$('answer-search').addEventListener('input',renderAnswers);
function visiblePage(){return visibleJobs().slice(pageIndex*pageSize,(pageIndex+1)*pageSize);}
$('page-prev').addEventListener('click',()=>{pageIndex--;renderApplications();});
$('page-next').addEventListener('click',()=>{pageIndex++;renderApplications();});
$('theme').value=document.documentElement.dataset.theme || 'system';
$('theme').addEventListener('change',()=>{document.documentElement.dataset.theme=$('theme').value;try{localStorage.setItem('formwright-theme',$('theme').value);}catch{}});
try{$('auto-sync').checked=localStorage.getItem('formwright-auto-sync')!=='off';}catch{}
$('auto-sync').addEventListener('change',()=>{try{localStorage.setItem('formwright-auto-sync',$('auto-sync').checked ? 'on' : 'off');}catch{}});
function openAdd(){showView('applications');$('add-box').hidden=false;$('add-box').open=true;$('urls').focus();}
$('add-open').addEventListener('click',openAdd);
document.addEventListener('keydown',event=>{
  if(event.ctrlKey || event.metaKey || event.altKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable)return;
  if(event.key==='/'){event.preventDefault();showView('applications');$('search').focus();}
  if(event.key.toLowerCase()==='n'){event.preventDefault();openAdd();}
});
async function syncSources(automatic){
  if(syncing || busy || pendingRows.size || (automatic && state?.worker.running))return;
  syncing=true;fingerprint='';render();
  try{
    const response=await fetch('/api/refresh',{method:'POST',headers:{'Content-Type':'application/json','X-Formwright-Token':document.querySelector('meta[name="formwright-token"]').content},body:'{}'});
    const result=await response.json();if(!response.ok)throw Error(result.error || 'Sync failed.');
    await refresh();
  }catch(err){error('connection',err.message);}
  finally{lastSourceSync=Date.now();syncing=false;fingerprint='';render();}
}
refresh();
setInterval(()=>{if(!document.hidden && !busy && !pendingRows.size)refresh();},3000);
setInterval(()=>{if(!document.hidden && $('auto-sync').checked && Date.now()-lastSourceSync>=60000)syncSources(true);},5000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
