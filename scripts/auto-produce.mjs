import { chromium } from 'playwright';
const BASE='https://facelesslab-api.joshdrn18.workers.dev', SITE='https://facelesslab.pages.dev/';
const email=process.env.FACELESSLAB_EMAIL,password=process.env.FACELESSLAB_PASSWORD;
const mode=process.env.FACELESSLAB_MODE||'private';
if(!email||!password||!['public','private','render-only'].includes(mode))throw new Error('Missing or invalid configuration');
const anchor='1e64e2f0-7d59-41b4-999b-1d992da26b0a';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let token,browser;
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
 const con=(await api('/api/publishing/connections')).connections||[];
 if(!con.some(c=>c.platform==='youtube'&&c.status==='active'))throw new Error('YouTube connection unavailable');
 let jobs=(await api('/api/publishing/jobs')).jobs||[];
 const publicParts=jobs.filter(j=>j.platform==='youtube'&&j.privacy==='public'&&j.status==='published'&&episode(j.title)>=20);
 const latest=Math.max(...publicParts.map(j=>episode(j.title)),20);
 const localDay=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
 if(publicParts.some(j=>episode(j.title)>20&&localDay(Number(j.created_at)*1000)===localDay(Date.now()))){console.log('Daily public episode already created');}
 else{
 const next=latest+1;
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
 if(mode==='render-only'&&!children.length)throw new Error('Render-only pilot requires existing episode assets');
 const project=children[0]||(await api('/api/projects/'+parent.id+'/continue','POST',{})).project;
 if(!project?.id||Number(project.episode_number)!==next)throw new Error('Continuation project invalid');
 const id=project.id;
 console.log('Continuing existing series: Part '+next);
 let scriptState=await api('/api/projects/'+id+'/script');
 if(mode==='render-only'&&!scriptState.script)throw new Error('Saved script missing; no inference allowed during pilot');
 if(!scriptState.script&&!['queued','processing'].includes(scriptState.status))await api('/api/projects/'+id+'/generate-script','POST',{});
 browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required']});
 const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
 await context.addInitScript(session=>{if(location.origin==='https://facelesslab.pages.dev')localStorage.setItem('facelesslab_token',session)},token);
 const page=await context.newPage();
 if(mode==='render-only')await page.route(BASE+'/**',route=>route.request().method()==='POST'?route.abort():route.continue());
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
 if(mode==='render-only'){
  await page.evaluate(async id=>{
   const quality=$('editor-quality-'+id);if(quality)quality.value='720';
   const lang=$('editor-subtitle-language-'+id);if(lang)lang.value='en';
   const button=$('editor-btn-'+id);if(!button)throw new Error('Render editor unavailable');await renderProjectVideo(id,button);
  },id);
  const result=await page.evaluate(async id=>{
   const url=window.facelessRenderedUrls?.[id];if(!url)throw new Error('No rendered video');
   const v=document.createElement('video');v.preload='metadata';v.src=url;
   await new Promise((resolve,reject)=>{v.onloadedmetadata=resolve;v.onerror=reject;setTimeout(()=>reject(new Error('Video metadata timeout')),15000)});
   return {width:v.videoWidth,height:v.videoHeight,duration:v.duration};
  },id);
  if(result.height<=result.width||result.duration<10||result.duration>181)throw new Error('Render validation failed');
  console.log('Render-only pilot passed: '+JSON.stringify(result)+'; no AI, backup or publishing POST allowed.');
 }else{
 const backupPromise=page.waitForResponse(r=>r.url()===BASE+'/api/video-backups'&&r.request().method()==='POST'&&r.ok(),{timeout:25*60000});
 const [backupResponse]=await Promise.all([backupPromise,page.evaluate(async id=>{const button=$('editor-btn-'+id);if(!button)throw new Error('Render editor unavailable');const q=$('editor-quality-'+id);if(q)q.value='720';await renderProjectVideo(id,button)},id)]);
 const backup=(await backupResponse.json()).backup;
 if(!backup?.id)throw new Error('R2 backup missing');
 const quality=await page.evaluate(async id=>{
  const url=window.facelessRenderedUrls?.[id];if(!url)return false;
  const v=document.createElement('video');v.preload='metadata';v.src=url;
  await new Promise((resolve,reject)=>{v.onloadedmetadata=resolve;v.onerror=reject;setTimeout(()=>reject(new Error('Video metadata timeout')),15000)});
  return v.videoHeight>v.videoWidth&&v.duration>10&&v.duration<181;
 },id);
 if(!quality)throw new Error('Rendered output failed duration or portrait validation');
 const script=(await api('/api/projects/'+id+'/script')).script;
 if(!script)throw new Error('Script missing');
 const rawTitle=String(script.youtube_title_options?.[0]||script.title||'').replace(/^Part\s+\d+\s*[:—–-]?\s*/i,'');
 const title=('Part '+next+': '+(rawTitle||'Kenji’s story continues')).slice(0,100);
 const tags=[];let length=0;
 for(const raw of (Array.isArray(script.youtube_tags)?script.youtube_tags:[])){const tag=String(raw).trim().replace(/^#+/,'');if(tag&&!tags.includes(tag)&&tags.length<30&&length+Buffer.byteLength(tag)+1<=480){tags.push(tag);length+=Buffer.byteLength(tag)+1;}}
 jobs=(await api('/api/publishing/jobs')).jobs||[];
 if(jobs.some(j=>j.platform==='youtube'&&episode(j.title)===next))throw new Error('Duplicate publishing job detected before upload');
 const job=(await api('/api/publishing/jobs','POST',{backup_id:backup.id,platform:'youtube',title,description:String(script.youtube_description||''),hashtags:(Array.isArray(script.hashtags)?script.hashtags:[]).join(' '),tags,privacy:mode,scheduled_at:new Date(Date.now()+90000).toISOString()})).job;
 if(!job?.id)throw new Error('Publish job missing');
 console.log('Upload queued: Part '+next);
 for(let i=0;i<40;i++){await sleep(15000);const current=(await api('/api/publishing/jobs')).jobs?.find(j=>j.id===job.id);if(current?.status==='published'){console.log('Published '+current.provider_url);break;}if(['failed','cancelled'].includes(current?.status))throw new Error('Publishing failed; inspect dashboard');if(i===39)throw new Error('Publishing pending; do not duplicate');}
 }
 }
}finally{if(browser)await browser.close();if(token)await api('/api/auth/logout','POST',{}).catch(()=>{});}
