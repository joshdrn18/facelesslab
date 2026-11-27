import { chromium } from 'playwright';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const BASE='https://facelesslab-api.joshdrn18.workers.dev', SITE='https://facelesslab.pages.dev/';
const email=process.env.FACELESSLAB_EMAIL,password=process.env.FACELESSLAB_PASSWORD;
const mode=process.env.FACELESSLAB_MODE||'private';
if(!email||!password||!['public','private','render-only','budget-audit'].includes(mode))throw new Error('Missing or invalid configuration');
const anchor='1e64e2f0-7d59-41b4-999b-1d992da26b0a';
const pilotOnly=process.env.FACELESSLAB_PILOT_ONLY==='true';
const reuseOnly=mode==='render-only'||(mode==='public'&&pilotOnly);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const slot=process.env.FACELESSLAB_PUBLISH_SLOT||'';
let publishAt=null;
if(mode==='public'){
 if(!['12','20'].includes(slot))throw new Error('Public run requires an explicit WIB publishing slot');
 const utc=new Date();utc.setUTCHours(Number(slot)-7,0,0,0);publishAt=utc;
 if(publishAt.getTime()-Date.now()<120000||publishAt.getTime()-Date.now()>90*60000)throw new Error('Publishing window missed or invalid; skip rather than upload late');
}
let token,browser,workdir,returnAudit=false;
async function api(path,method='GET',body){
 const res=await fetch(BASE+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
 const data=await res.json().catch(()=>({}));
 if(!res.ok)throw new Error('API '+path.split('/').slice(0,4).join('/')+' HTTP '+res.status);
 return data;
}
const episode=t=>Number(String(t||'').match(/\bPart\s+(\d+)\b/i)?.[1]||0);
try{
 token=(await api('/api/auth/login','POST',{email,password})).token;
 if(!token)throw new Error('Login failed');
 if(mode==='budget-audit'||mode==='public'){
  const b=await api('/api/admin/cloudflare-billing');
  const bill=b.billable_usage||{}, ai=b.ai_analytics||{}, today=ai.today||{};
  const summary={billingAvailable:bill.success===true,billedCost:bill.success?bill.total_billed_cost:null,currency:bill.currency||null,billingRecords:bill.record_count??null,usagePeriodTo:bill.period_to||null,aiAnalyticsAvailable:ai.success===true,neurons:today.neurons??null,remainingNeurons:today.remaining_neurons??null};
  console.log('Budget audit: '+JSON.stringify(summary));
  const subs=b.subscriptions||{};
  console.log('Account plan audit: '+JSON.stringify({available:subs.success===true,plans:Array.isArray(subs.plans)?subs.plans:[],httpStatus:subs.http_status??null}));
  const latestPeriod=String(bill.period_to||'').slice(0,10);
  const records=Array.isArray(bill.records)?bill.records:[];
  console.log('Resource billing audit: '+JSON.stringify({period:latestPeriod,services:bill.services||[],latestUsage:(bill.daily_usage||[]).slice(-2),recordUnits:[...new Set(records.map(r=>r.unit))]}));
  // All-account limits, with conservative buffers. Treat missing/malformed metrics
  // as a hard stop for production. Aggregate all R2 operations against the smaller
  // Class A allowance, rather than risking a classification error.
  let resourceAudit;
  try{resourceAudit=await api('/api/admin/production-resource-audit');}
  catch(error){resourceAudit={ok:false,error:String(error.message||error)};}
  const sumMetric=(metric,key)=>{
   if(metric?.success!==true||!Array.isArray(metric.rows))return null;
   if(metric.rows.some(row=>typeof row.sum?.[key]!=='number'||!Number.isFinite(row.sum[key])||row.sum[key]<0))return null;
   return metric.rows.reduce((total,row)=>total+row.sum[key],0);
  };
  const s2=resourceAudit.r2_storage?.result;
  const byteFields=['payloadSize','metadataSize'];
  const buckets=[s2?.standard?.published,s2?.standard?.uploaded,s2?.infrequentAccess?.published,s2?.infrequentAccess?.uploaded];
  const storageBytes=resourceAudit.r2_storage?.success===true&&buckets.every(x=>x&&byteFields.every(k=>typeof x[k]==='number'&&Number.isFinite(x[k])&&x[k]>=0))?buckets.reduce((total,x)=>total+x.payloadSize+x.metadataSize,0):null;
  const infrequentBytes=storageBytes===null?null:buckets.slice(2).reduce((total,x)=>total+x.payloadSize+x.metadataSize,0);
  const metrics={r2StorageBytes:storageBytes,r2InfrequentBytes:infrequentBytes,r2MonthlyOperations:sumMetric(resourceAudit.r2_month_operations,'requests'),workersRequests:sumMetric(resourceAudit.workers_daily,'requests'),d1RowsRead:sumMetric(resourceAudit.d1_daily,'rowsRead'),d1RowsWritten:sumMetric(resourceAudit.d1_daily,'rowsWritten'),queueOperations:sumMetric(resourceAudit.queues_daily,'billableOperations')};
  const metricErrors=Object.fromEntries(Object.entries(resourceAudit).filter(([,value])=>value&&typeof value==='object'&&value.success===false).map(([key,value])=>[key,value.error||'unavailable']));
  const plans=Array.isArray(subs.plans)?subs.plans:[];
  const planSafe=subs.success===true&&plans.length===1&&plans[0].name==='R2 Paid'&&plans[0].price===0;
  const limits={r2StorageBytes:7000000000,r2MonthlyOperations:700000,workersRequests:70000,d1RowsRead:3500000,d1RowsWritten:70000,queueOperations:7000};
  const headroomSafe=Object.entries(limits).every(([key,max])=>Number.isFinite(metrics[key])&&metrics[key]<max)&&metrics.r2InfrequentBytes===0;
  console.log('Production resource preflight: '+JSON.stringify({metrics,limits,metricErrors,planSafe,headroomSafe,checkedAt:resourceAudit.checked_at||null}));
  if(mode==='public'&&(!planSafe||!headroomSafe||resourceAudit.ok!==true))throw Error('Production resource audit incomplete or safety buffer reached; no production started');
  if(mode==='budget-audit')returnAudit=true;
  else if(!summary.billingAvailable||!summary.aiAnalyticsAvailable||summary.billingRecords===0||summary.billedCost!==0||!Number.isFinite(summary.neurons)||summary.neurons>=6000)throw new Error('Budget data unavailable or safety threshold reached; production blocked');
 }
 if(!returnAudit){
 const con=(await api('/api/publishing/connections')).connections||[];
 if(!con.some(c=>c.platform==='youtube'&&c.status==='active'))throw new Error('YouTube connection unavailable');
 let jobs=(await api('/api/publishing/jobs')).jobs||[];
 const publicParts=jobs.filter(j=>j.platform==='youtube'&&j.privacy==='public'&&j.status==='published'&&episode(j.title)>=20);
 const latest=Math.max(...publicParts.map(j=>episode(j.title)),20);
 const localDay=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
 const todaysJobs=jobs.filter(j=>j.platform==='youtube'&&episode(j.title)>20&&localDay(Number(j.scheduled_at||j.created_at)*1000)===localDay(Date.now()));
 if(mode==='public'&&(todaysJobs.length>=2||todaysJobs.some(j=>Math.abs(Number(j.scheduled_at)*1000-publishAt.getTime())<60000))){console.log('Daily two-episode cap or publishing slot already used');}
 else{
 const next=latest+1;
 if(mode==='public'&&pilotOnly&&next!==21)throw Error('Part 21 pilot verification required before later episodes');
 const existingJobs=jobs.filter(j=>j.platform==='youtube'&&episode(j.title)===next);
 if(existingJobs.some(j=>['queued','uploading','processing','draft','failed'].includes(j.status))){throw new Error('Existing next-episode publishing job requires inspection; no duplicate will be made');}
 if(existingJobs.some(j=>j.status==='published')){throw new Error('Episode already uploaded with different visibility; inspect before publishing');}
 const projectData=await api('/api/projects');
 const projects=projectData.projects||[];
 let parent=projects.find(p=>p.id===anchor);
 if(!parent)throw new Error('Part 20 source project not found');
 for(let n=21;n<=latest;n++){
  const candidates=projects.filter(p=>p.parent_project_id===parent.id&&Number(p.episode_number)===n);
  if(candidates.length!==1)throw new Error('Series lineage ambiguous or missing at Part '+n);
  parent=candidates[0];
 }
 let children=projects.filter(p=>p.parent_project_id===parent.id&&Number(p.episode_number)===next);
 if(children.length>1)throw new Error('Multiple candidate continuation projects; no duplicate created');
 if(reuseOnly&&!children.length)throw new Error('Render-only pilot requires existing episode assets');
 const project=children[0]||(await api('/api/projects/'+parent.id+'/continue','POST',{})).project;
 if(!project?.id||Number(project.episode_number)!==next)throw new Error('Continuation project invalid');
 const id=project.id;
 console.log('Continuing existing series: Part '+next);
 let scriptState=await api('/api/projects/'+id+'/script');
 if(reuseOnly&&!scriptState.script)throw new Error('Saved script missing; no inference allowed during pilot');
 if(!scriptState.script&&!['queued','processing'].includes(scriptState.status))await api('/api/projects/'+id+'/generate-script','POST',{});
 browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required']});
 const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
 await context.addInitScript(session=>{if(location.origin==='https://facelesslab.pages.dev')localStorage.setItem('facelesslab_token',session)},token);
 const page=await context.newPage();
 await page.route(BASE+'/**',route=>{const req=route.request();return req.method()==='POST'&&(reuseOnly||req.url()===BASE+'/api/video-backups')?route.abort():route.continue();});
 await page.goto(SITE,{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>typeof refreshProjects==='function'&&!!document.getElementById('appScreen')&&!document.getElementById('appScreen').classList.contains('hidden'),{},{timeout:90000});
 await page.evaluate(async id=>{
  await waitForScheduledScript(id); await refreshProjects(); await loadSavedScript(id);
  const voice=await api('/api/projects/'+id+'/voice');
  if(!voice.voice&&!['queued','processing'].includes(voice.status))await api('/api/projects/'+id+'/generate-voice',{method:'POST',body:'{}'});
  await waitForScheduledVoice(id);await loadSavedVoice(id);
  const visual=await api('/api/projects/'+id+'/visuals');
  for(const v of visual.visuals||[])await showSceneVisual(id,v.scene_number,v);
  const button=$('visual-all-btn-'+id);if(!button)throw new Error('Visual editor unavailable');
  await generateAllSceneVisuals(id,button);
  const sub=await api('/api/projects/'+id+'/subtitles');
  if(!sub.subtitles?.cues?.length)await requestProjectSubtitles(id);
  else renderSubtitleResult(id,sub.subtitles);
 },id);
 console.log('Assets ready');
 await page.evaluate(async id=>{
  const q=$('editor-quality-'+id);if(q)q.value='720';
  const lang=$('editor-subtitle-language-'+id);if(lang)lang.value='en';
  const button=$('editor-btn-'+id);if(!button)throw new Error('Render editor unavailable');
  await renderProjectVideo(id,button);
 },id);
 workdir=await mkdtemp(join(tmpdir(),'facelesslab-'));
 const file=join(workdir,'episode.mp4');
 const bytes=await page.evaluate(async id=>{
  const url=window.facelessRenderedUrls?.[id];if(!url)throw new Error('No rendered video');
  const blob=await (await fetch(url)).blob();
  if(blob.size<10000||blob.size>85*1024*1024)throw new Error('Unexpected render size');
  return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Read render failed'));reader.readAsDataURL(blob);});
 },id);
 await writeFile(file,Buffer.from(bytes,'base64'));
 const result=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8'}));
 const video=result.streams.find(s=>s.codec_type==='video'),audio=result.streams.find(s=>s.codec_type==='audio'),duration=Number(result.format.duration);
 if(!video||!audio||video.height<=video.width||!Number.isFinite(duration)||duration<10||duration>181||video.codec_name!=='h264')throw new Error('Rendered file failed video/audio validation');
 if(Math.abs(Number(audio.duration||duration)-duration)>2)throw new Error('Audio/video duration mismatch');
 execFileSync('ffmpeg',['-v','error','-xerror','-i',file,'-f','null','-'],{timeout:120000});
 console.log('Native media verification: '+JSON.stringify({width:video.width,height:video.height,duration,audio:audio.codec_name,video:video.codec_name,size:Number(result.format.size)}));
 if(mode==='render-only'){
  console.log('Render-only pilot passed; no new AI, backup or publishing requests allowed.');
 }else{
 if(publishAt&&publishAt.getTime()-Date.now()<120000)throw new Error('Render finished too late for requested slot; no upload queued');
 const data=await readFile(file);
 const scriptForBackup=(await api('/api/projects/'+id+'/script')).script;
 const backupResponse=await fetch(BASE+'/api/video-backups',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'video/mp4','x-video-title':encodeURIComponent(String(scriptForBackup?.title||'FacelessLab episode').slice(0,160)),'x-video-duration':String(duration),'x-video-quality':'720'},body:data,signal:AbortSignal.timeout(120000)});
 if(!backupResponse.ok)throw new Error('Cloud backup rejected: HTTP '+backupResponse.status);
 const backup=(await backupResponse.json()).backup;
 if(!backup?.id)throw new Error('R2 backup missing');
 const script=(await api('/api/projects/'+id+'/script')).script;
 if(!script)throw new Error('Script missing');
 const rawTitle=String(script.title||script.youtube_title_options?.[0]||'').replace(/^Part\s+\d+\s*[:—–-]?\s*/i,'');
 const title=('Part '+next+': '+(rawTitle||'Kenji’s story continues')).slice(0,100);
 const tags=[];let length=0;
 for(const raw of (Array.isArray(script.youtube_tags)?script.youtube_tags:[])){const tag=String(raw).trim().replace(/^#+/,'');if(tag&&!tags.includes(tag)&&tags.length<30&&length+Buffer.byteLength(tag)+1<=480){tags.push(tag);length+=Buffer.byteLength(tag)+1;}}
 jobs=(await api('/api/publishing/jobs')).jobs||[];
 if(jobs.some(j=>j.platform==='youtube'&&episode(j.title)===next))throw new Error('Duplicate publishing job detected before upload');
 const previous=jobs.find(j=>j.platform==='youtube'&&episode(j.title)===next-1&&j.status==='published'&&j.privacy==='public');
 const description=String(script.youtube_description||script.hook||'Kenji protects Neo-Tokyo.').trim()+(previous?.provider_url?'\n\nPrevious episode: '+previous.provider_url:'')+'\n\nSubscribe for the next chapter.';
 const job=(await api('/api/publishing/jobs','POST',{backup_id:backup.id,platform:'youtube',title,description,hashtags:(Array.isArray(script.hashtags)?script.hashtags:[]).join(' '),tags,privacy:mode,scheduled_at:(publishAt||new Date(Date.now()+90000)).toISOString()})).job;
 if(!job?.id)throw new Error('Publish job missing');
 console.log('Upload queued: Part '+next+' at '+(publishAt?.toISOString()||'next available time'));
 if(!publishAt)for(let i=0;i<40;i++){await sleep(15000);const current=(await api('/api/publishing/jobs')).jobs?.find(j=>j.id===job.id);if(current?.status==='published'){console.log('Published '+current.provider_url);break;}if(['failed','cancelled'].includes(current?.status))throw new Error('Publishing failed; inspect dashboard');if(i===39)throw new Error('Publishing pending; do not duplicate');}
 }
 }
}
}finally{if(workdir)await rm(workdir,{recursive:true,force:true});if(browser)await browser.close();if(token)await api('/api/auth/logout','POST',{}).catch(()=>{});}
