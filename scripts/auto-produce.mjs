import { chromium } from 'playwright';

const BASE = 'https://facelesslab-api.joshdrn18.workers.dev';
const SITE = 'https://facelesslab.pages.dev/';
const email = process.env.FACELESSLAB_EMAIL;
const password = process.env.FACELESSLAB_PASSWORD;
const mode = process.env.FACELESSLAB_MODE || 'private';
if (!email || !password) throw new Error('Configure FACELESSLAB_EMAIL and FACELESSLAB_PASSWORD in repository Actions secrets.');
if (!['private','public'].includes(mode)) throw new Error('Invalid publishing mode.');
const localDay = d => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const date = localDay(new Date());
const seeds = [
 'A courier delivers a letter from tomorrow, and must decide whether to open it.',
 'A lighthouse keeper discovers a tiny star that only shines when someone tells the truth.',
 'A young clockmaker finds a city where every clock counts down to a different secret.',
 'An apprentice cartographer discovers an island that appears only in reflections.',
 'A train conductor finds a ticket to a forgotten memory and returns it to its owner.',
 'A gardener discovers a seed that grows into a doorway to the past.',
 'A library keeper finds a book that rewrites itself when someone makes a kind choice.',
 'A mountain village wakes up to a sky filled with floating lanterns carrying lost memories.',
 'A repair artist restores a broken music box that can replay a single unspoken goodbye.',
 'A traveler encounters a bridge that appears only when two strangers cooperate.'
];
const stamp = '[FL-AUTO ' + date + ']';
const seed = seeds[Math.floor(Date.now()/86400000)%seeds.length];
const topic = stamp+' Create a complete original cinematic anime-inspired short story in English: '+seed+' Strong hook in the first two seconds, clear emotional stakes, coherent ending, consistent characters, vertical 9:16. Avoid copyrighted characters, recycled footage, claims of real events, and repetitive narration. Do not include the scheduling marker in the video or public metadata.';
let token, browser, id;
async function api(path, method='GET', body) {
 const response=await fetch(BASE+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
 const data=await response.json().catch(()=>({}));
 if(!response.ok) throw new Error('API '+path.split('/').slice(0,4).join('/')+' HTTP '+response.status);
 return data;
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
 const login=await api('/api/auth/login','POST',{email,password});
 token=login.token;
 if(!token) throw new Error('Login returned no session.');
 const connections=await api('/api/publishing/connections');
 if(!connections.connections?.some(c=>c.platform==='youtube'&&c.status==='active')) throw new Error('YouTube connection is not active.');
 const schedules=(await api('/api/production/schedules')).schedules||[];
 const active=['scheduled','starting','script_queued','producing','rendering','awaiting_review','publish_queued'];
 const existing=schedules.find(s=>String(s.topic||'').startsWith(stamp));
 const foreign=schedules.find(s=>active.includes(s.status)&&s.id!==existing?.id);
 if(foreign) { console.log('Skipped: another production is active.'); process.exitCode=0; }
 else if(existing&&!active.includes(existing.status)){console.log('Skipped: daily production already exists, status '+existing.status);}
 else {
  if(existing){id=existing.id;}
  else {
   const start=new Date(Date.now()+60000);
   const publish=new Date(Date.now()+20*60000);
   const result=await api('/api/production/schedules','POST',{topic,style:'anime',duration_seconds:30,platform:'youtube',privacy:mode,production_at:start.toISOString(),publish_at:publish.toISOString(),review_required:false});
   id=result.schedule?.id;
   if(!id)throw new Error('Schedule ID missing.');
  }
  browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({viewport:{width:1440,height:900},permissions:[],serviceWorkers:'block'});
  await context.addInitScript(session=>{if(location.origin==='https://facelesslab.pages.dev') localStorage.setItem('facelesslab_token',session);},token);
  const page=await context.newPage();
  await page.goto(SITE,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(()=>typeof refreshProductionSchedules==='function'&&!!document.getElementById('appScreen')&&!document.getElementById('appScreen').classList.contains('hidden'),{},{timeout:90000});
  await page.evaluate(()=>refreshProductionSchedules());
  let last='';
  const deadline=Date.now()+42*60000;
  while(Date.now()<deadline){
   const item=(await api('/api/production/schedules')).schedules?.find(s=>s.id===id);
   if(!item)throw new Error('Production schedule disappeared.');
   if(item.status!==last){last=item.status; console.log('Production: '+last);}
   if(item.status==='published'){console.log('Published: '+(item.provider_url||'provider URL pending'));break;}
   if(['failed','cancelled','awaiting_review'].includes(item.status))throw new Error('Production stopped: '+item.status);
   await sleep(20000);
  }
  if(last!=='published')throw new Error('Timed out; inspect existing schedule before retrying. No duplicate will be created today.');
 }
} finally {
 if(browser)await browser.close();
 if(token)await api('/api/auth/logout','POST',{}).catch(()=>{});
}
