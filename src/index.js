const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });

const encoder = new TextEncoder();
const SESSION_DAYS = 30;

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replaceAll("+", "-").replaceAll("/", "_");
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, saltHex) {
  const salt = saltHex
    ? Uint8Array.from(saltHex.match(/.{2}/g).map(x => parseInt(x, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  const hash = [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, "0")).join("");
  return { salt: [...salt].map(x => x.toString(16).padStart(2, "0")).join(""), hash };
}

async function getUser(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  return env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.role, u.status
     FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`
  ).bind(tokenHash, now).first();
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role
  };
}


function extractJson(text) {
  const cleaned = String(text || "").trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  throw new Error("AI returned an invalid script format.");
}

async function callAiProvider(env, provider, prompt) {
  const baseUrl = String(provider.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const endpoint = baseUrl + "/chat/completions";
  const headers = {
    "authorization": "Bearer " + provider.apiKey,
    "content-type": "application/json"
  };
  const model = provider.model || "gpt-4o-mini";
  const messages = [
    { role: "system", content: "You are an expert YouTube storyteller, documentary writer, voice-over script editor, and metadata strategist. Write vivid, natural English that sounds like a skilled human narrator speaking to one person, not an essay being read aloud. Prioritize clear breath groups, effortless pronunciation, varied cadence, and emotional authenticity. Avoid repetitive wording, generic AI phrases, filler, fake suspense, and unsupported claims. Silently revise awkward sentences before returning. Optimize for viewer satisfaction and honest discoverability. Return one valid JSON object only; no markdown fences or commentary." },
    { role: "user", content: prompt }
  ];

  async function requestJson(useJsonMode, tokenLimit = 3500) {
    const body = {
      model,
      temperature: 0.68,
      max_completion_tokens: tokenLimit,
      messages
    };
    // Groq GPT-OSS spends completion tokens on reasoning unless it is disabled.
    if (String(model).toLowerCase().includes("openai/gpt-oss")) {
      body.reasoning_effort = "low";
      body.include_reasoning = false;
    }
    if (useJsonMode) body.response_format = { type: "json_object" };
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(55000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data.error?.message || data.message || ("AI provider returned HTTP " + response.status);
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (!content) {
      const reason = choice?.finish_reason || "unknown";
      throw new Error("AI provider returned no script content (finish reason: " + reason + ").");
    }
    return extractJson(content);
  }

  try {
    return await requestJson(true);
  } catch (firstError) {
    const message = String(firstError.message || firstError);
    const retryable = firstError.status === 400 || /failed_generation|json|invalid script format|no script content|response_format/i.test(message);
    if (!retryable) throw firstError;
    try {
      return await requestJson(false, 6000);
    } catch (retryError) {
      throw new Error("AI could not produce a valid script JSON after retry. First attempt: " + message.slice(0, 240) + " | Retry: " + String(retryError.message || retryError).slice(0, 240));
    }
  }
}

async function generateScriptWithProviders(env, project, continuation = null) {
  const targetSeconds = Number(project.duration_seconds) || 45;
  const targetWords = Math.round(targetSeconds * 2.25);
  const minWords = Math.round(targetWords * 0.92);
  const maxWords = Math.round(targetWords * 1.08);
  const prompt = [
    project.style === "anime"
      ? "You are a Japanese anime short-film director and storyboard artist. Create a coherent anime episode, not a slideshow. Design recurring characters and preserve their exact appearance across every scene."
      : "You are a professional short-form documentary director and storyboard artist. Create a coherent visual story, not a random image slideshow.",
    `Return exactly one valid JSON object with this schema: {"title":"string","hook":"string","narration":"string","scenes":[{"scene":"number","duration_seconds":"number","voiceover":"string","visual_prompt":"string","on_screen_text":"string","transition":"string"}],"closing":"string","cta":"string","estimated_duration_seconds":"number","series_summary":"string","character_bible":"string","characters":[{"id":"stable-slug","name":"string","role":"string","visual_identity":"string","signature_outfit":"string","distinctive_features":"string"}],"ending_state":"string","youtube_title_options":["string","string","string"],"youtube_description":"string","youtube_tags":["string"],"hashtags":["string"],"thumbnail_text":"string","pinned_comment":"string"}.`,
    "Narration must contain " + minWords + " to " + maxWords + " spoken words (aim for " + targetWords + "). Keep it natural and avoid padding.",
    "VOCABULARY: Use broad, precise, varied vocabulary suited to the topic. Mix short punchy lines with longer flowing sentences. Prefer concrete verbs, specific nouns, sensory detail, fresh comparisons and conversational phrasing. Vary sentence openings, transitions and sentence rhythm. Avoid thesaurus stuffing, cliches, filler, repeated adjectives, repeated rhetorical questions and robotic phrases such as Imagine this, In this video, Let us dive in. Every sentence must add a fact, image, emotion or forward movement.",
    "VOICE-OVER PERFORMANCE: Write for the ear, not the page. Use clear spoken English and natural contractions when they fit. Most sentences should be easy to say in one breath; favor roughly 8–18 words, while deliberately varying length for impact. Break up overloaded sentences instead of chaining several clauses. Use commas and periods for natural pauses; do not rely on repeated ellipses, exclamation marks, or rhetorical questions. Avoid starting consecutive sentences with the same word and do not overuse transitions such as But, And, Now, or Then. Avoid fragments that sound accidental, tongue-twisters, dense lists of names, and formal essay phrases. Read every line mentally as narration and rewrite anything stiff, vague, repetitive, or difficult to pronounce.",
    project.style === "anime" ? "ANIME NARRATION TONE: Make the English narration cinematic and emotionally grounded, with vivid but concise imagery, character motivation, tension, and meaningful emotional turns. Do not make every line melodramatic or shouty. Let quiet moments breathe and make dialogue-like narration feel believable." : "DOCUMENTARY NARRATION TONE: Sound curious, confident, conversational, and precise. Explain complex ideas in plain language without talking down to viewers. Let surprising facts create the drama; do not manufacture emotion or use sensational wording.",
    "SILENT SCRIPT EDIT: Before returning JSON, check the narration for repeated sentence patterns, duplicated ideas, abrupt logic jumps, unnatural TTS phrasing, and sentences that are too long to speak comfortably. Improve them without changing facts, story events, target word count, or the required narration-to-scene order.",
    "RETENTION: Open with a concrete curiosity gap or striking detail in the first sentence. Establish why viewers should care immediately. Build a clear progression with escalating discoveries, meaningful stakes, pattern interrupts and satisfying payoffs. Do not reveal the full payoff in the opening. Avoid fake cliffhangers, empty hype and repetitive summaries. End with a memorable takeaway and a brief natural CTA.",
    "FACTUAL INTEGRITY: Never invent statistics, quotations, studies, dates, named sources or historical details. Phrase uncertainty cautiously. Do not present speculation as fact. Titles must be compelling but truthful, not deceptive clickbait.",
    "YOUTUBE PUBLISHING PACK: Provide 3 distinct concise title options. Write a useful description with a strong first 2 lines, concise summary, relevant context and natural CTA; no keyword stuffing. Provide 8–15 relevant search tags as plain phrases without #, 3–5 relevant hashtags with #, thumbnail_text of 2–5 punchy mobile-readable words that does not simply repeat the title, and a pinned_comment that invites a genuine response.",
    "Create 5 to 7 scenes covering the full target duration. Scene voiceovers must divide the narration in order, preserve its exact sequence, and collectively cover the whole narration.",
    "STORYBOARD RULES: Every scene must depict the exact event, person, place, object, or action being described by that scene's voiceover. Build a logical beginning-middle-ending sequence. Each scene must be a new visual moment and materially different from the previous scene; never reuse the same image idea, pose, camera angle, or setting just to fill time.",
    "CHARACTER CAST: Return 1–5 recurring character profiles with stable id, name, role, visual_identity, signature_outfit and distinctive_features. Keep each design distinct and consistent. Mention named characters in scene visual prompts where natural. Return an empty characters array if none. "+
    "VISUAL PROMPT RULES: Write each visual_prompt as a concrete image-generation instruction describing one specific photographic/cinematic moment, including subject, action, setting, and shot framing. Make prompts specific and distinct, not vague mood words. Keep recurring people recognizably consistent across scenes by repeating concise identity, age range, hairstyle, clothing, and other non-sensitive visual details when relevant. Keep the overall art direction, color palette, lighting, and realism consistent across the whole story.",
    "Never request collages, grids, split screens, contact sheets, storyboards, comic panels, screenshots, posters, infographics, UI, multiple frames, or images containing text. Each visual must be one clean full-frame scene. No text, captions, logos, borders, or watermarks in the image.",
    "Keep each on_screen_text under 8 words and each transition to a few words. Scene voiceovers must preserve the narration sequence exactly, covering every sentence once without omissions or duplication. Keep narration smooth for TTS: clean punctuation, pronounceable names, no stage directions, emoji, markdown or bracketed sound effects. Start with a strong 2-second hook and finish with a natural CTA. Return JSON only; no markdown or commentary.",
    "Topic: " + project.topic,
    "LANGUAGE REQUIREMENT: Write every audience-facing element in fluent natural English only: title, hook, narration, scene voiceovers, on-screen text, closing and CTA. Do not use Indonesian, Japanese, or mixed-language text. Anime mode changes the visual art direction only; the story and narration must remain in English.",
    "Language: English",
    "Target duration: " + targetSeconds + " seconds",
    "Visual style / art direction: " + project.style,
    ...(continuation ? [
      "SERIES CONTINUATION — EPISODE " + Number(project.episode_number || 2) + ". This is NOT a reboot, recap, alternate take, or unrelated new story. Continue the exact same story immediately after the previous episode ends. Start the title with Part " + Number(project.episode_number || 2) + ".",
      "PREVIOUS EPISODE TITLE: " + String(continuation.previous_title || "").slice(0,160),
      "SERIES STORY SO FAR: " + String(continuation.series_summary || continuation.previous_narration || "").slice(-2200),
      "CHARACTER BIBLE — preserve names, faces, hairstyles, clothing, personalities and relationships exactly: " + String(continuation.character_bible || "Preserve the same established characters and designs.").slice(0,1200),
      "EXACT ENDING STATE OF LAST EPISODE: " + String(continuation.ending_state || continuation.previous_ending_voiceover || "").slice(0,900),
      "LAST SHOT VISUAL DESCRIPTION: " + String(continuation.previous_ending_visual_prompt || "").slice(0,800),
      "CONTINUITY RULES: Open on the same moment, place and action where the previous episode ended. Carry forward unresolved actions and emotional stakes. Do not repeat the opening, summarize the previous episode, change character identities, outfits or visual world without story reason, or resolve the cliffhanger immediately. Advance the plot naturally. Make the final scene lead clearly into a possible next episode. Return updated series_summary, character_bible and ending_state for the next continuation."
    ] : [])
  ].join("\n");
  const primary = {
    apiKey: env.AI_API_KEY,
    baseUrl: env.AI_BASE_URL,
    model: env.AI_MODEL
  };
  const fallback = {
    apiKey: env.AI_FALLBACK_API_KEY,
    baseUrl: env.AI_FALLBACK_BASE_URL,
    model: env.AI_FALLBACK_MODEL
  };
  let firstError;
  if (primary.apiKey) {
    try { return { script: await callAiProvider(env, primary, prompt), provider: "primary" }; }
    catch (error) { firstError = error; }
  }
  if (fallback.apiKey) {
    try { return { script: await callAiProvider(env, fallback, prompt), provider: "fallback" }; }
    catch (error) { throw new Error("Primary and fallback AI providers failed. " + (firstError?.message || "") + " " + error.message); }
  }
  if (firstError) throw firstError;
  throw new Error("AI provider is not configured. Add AI_API_KEY and AI_MODEL to Worker secrets/variables.");
}

async function processScriptQueueMessage(message, env) {
 const job=message.body||{}, generationId=String(job.generation_id||""), projectId=String(job.project_id||""), userId=String(job.user_id||"");
 if(job.type!=="generate_script"||!generationId||!projectId||!userId){message.ack();return;}
 const row=await env.DB.prepare("SELECT g.id,g.status,p.id AS project_id,p.title,p.topic,p.language,p.duration_seconds,p.style,p.parent_project_id,p.episode_number,p.continuity_json FROM generations g JOIN projects p ON p.id=g.project_id WHERE g.id=? AND g.project_id=? AND g.user_id=? AND p.user_id=? AND g.stage='script'").bind(generationId,projectId,userId,userId).first();
 if(!row||["completed","failed"].includes(row.status)){message.ack();return;}
 try{
  await env.DB.prepare("UPDATE generations SET status='processing',updated_at=unixepoch() WHERE id=? AND user_id=? AND status IN ('queued','processing')").bind(generationId,userId).run();
  await env.DB.prepare("UPDATE projects SET status='processing',updated_at=unixepoch() WHERE id=? AND user_id=?").bind(projectId,userId).run();
  const project={...row,user_id:userId};
  const continuation=project.parent_project_id&&project.continuity_json?JSON.parse(project.continuity_json):null;
  const result=await generateScriptWithProviders(env,project,continuation),script=result.script;
  script.characters=(Array.isArray(script.characters)?script.characters:[]).slice(0,8).map((c,i)=>{
   const name=String(c?.name||"").trim().slice(0,80);
   const id=String(c?.id||name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||("character-"+(i+1))).toLowerCase().replace(/[^a-z0-9-]+/g,"-").replace(/^-|-$/g,"").slice(0,80)||("character-"+(i+1));
   return {id,name,role:String(c?.role||"").trim().slice(0,180),visual_identity:String(c?.visual_identity||"").trim().slice(0,600),signature_outfit:String(c?.signature_outfit||"").trim().slice(0,350),distinctive_features:String(c?.distinctive_features||"").trim().slice(0,350)};
  }).filter(c=>c.name&&c.visual_identity);
  if(!script||typeof script!=="object"||!Array.isArray(script.scenes)||!script.narration)throw new Error("AI response is missing required script fields.");
  await env.DB.prepare("UPDATE generations SET status='completed',output_json=?,error_message=NULL,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(JSON.stringify({...script,_provider:result.provider}),generationId,userId).run();
  await env.DB.prepare("UPDATE projects SET status='completed',updated_at=unixepoch() WHERE id=? AND user_id=?").bind(projectId,userId).run();
  console.log(JSON.stringify({event:"background_script_completed",generation_id:generationId,project_id:projectId}));
  message.ack();
 }catch(error){
  const detail=String(error?.message||error).slice(0,500),attempts=Number(message.attempts||1);
  console.error(JSON.stringify({event:"background_script_attempt_failed",generation_id:generationId,attempts,error:detail}));
  if(attempts>=3){
   await env.DB.prepare("UPDATE generations SET status='failed',error_message=?,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(detail,generationId,userId).run();
   await env.DB.prepare("UPDATE projects SET status='failed',updated_at=unixepoch() WHERE id=? AND user_id=?").bind(projectId,userId).run();
   message.ack();
  }else message.retry({delaySeconds:Math.min(60,attempts*15)});
 }
}

async function processVoiceQueueMessage(message, env) {
 const job=message.body||{},generationId=String(job.generation_id||""),projectId=String(job.project_id||""),userId=String(job.user_id||"");
 if(job.type!=="generate_voice"||!generationId||!projectId||!userId){message.ack();return;}
 const row=await env.DB.prepare("SELECT g.id,g.status,g.input_json FROM generations g JOIN projects p ON p.id=g.project_id WHERE g.id=? AND g.project_id=? AND g.user_id=? AND p.user_id=? AND g.stage='voice'").bind(generationId,projectId,userId,userId).first();
 if(!row||["completed","failed"].includes(row.status)){message.ack();return;}
 try{
  const input=JSON.parse(row.input_json||"{}"),scriptRow=await env.DB.prepare("SELECT output_json FROM generations WHERE id=? AND project_id=? AND user_id=? AND stage='script' AND status='completed'").bind(input.script_generation_id,projectId,userId).first();
  if(!scriptRow)throw new Error("The source script is no longer available.");
  const script=JSON.parse(scriptRow.output_json);
  // Normalize narration for plain-text TTS without changing its wording or meaning.
  // MeloTTS does not expose SSML controls here, so punctuation is the pause signal.
  const rawNarration=String(script.narration||(script.scenes||[]).map(s=>s.voiceover||"").join(" "));
  const narration=rawNarration
    .replace(/\\r\\n?/g,"\\n")
    .replace(/[\\u2018\\u2019]/g,"'")
    .replace(/[\\u201C\\u201D]/g,'"')
    .replace(/[\\u2013\\u2014]/g,", ")
    .replace(/\\.{4,}/g,"...")
    .replace(/[ \\t]+/g," ")
    .replace(/ *\\n+ */g,"\\n")
    .replace(/\\s+([,.;!?])/g,"$1")
    .replace(/([,;:])(?=\\S)/g,"$1 ")
    .replace(/([.!?])(?=[A-Z])/g,"$1 ")
    .trim();
  if(!narration||narration.length>4500)throw new Error("Narration is empty or exceeds the current 4,500 character limit.");
  await env.DB.prepare("UPDATE generations SET status='processing',updated_at=unixepoch() WHERE id=? AND user_id=?").bind(generationId,userId).run();
  const model="@cf/myshell-ai/melotts",provider="cloudflare-workers-ai",result=await env.AI.run(model,{prompt:narration,lang:"en"}),audioValue=typeof result==="string"?result:result?.audio;
  if(!audioValue||typeof audioValue!=="string")throw new Error("The text-to-speech model returned no audio.");
  let audio;
  if(/^https:\/\//i.test(audioValue)){const response=await fetch(audioValue);if(!response.ok)throw new Error("Could not retrieve the generated audio file.");audio=new Uint8Array(await response.arrayBuffer());}
  else{const binary=atob(audioValue);audio=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)audio[i]=binary.charCodeAt(i);}
  if(!audio.byteLength)throw new Error("The text-to-speech model returned an empty audio file.");
  const objectKey="users/"+userId+"/projects/"+projectId+"/voice/"+generationId+".mp3";
  await env.MEDIA.put(objectKey,audio,{httpMetadata:{contentType:"audio/mpeg",cacheControl:"private, max-age=3600"},customMetadata:{userId,projectId,generationId}});
  const output={object_key:objectKey,mime_type:"audio/mpeg",bytes:audio.byteLength,provider,model,language:"en",characters:narration.length,source_characters:rawNarration.length,preprocessing:"punctuation-and-whitespace-normalized"};
  await env.DB.prepare("UPDATE generations SET status='completed',output_json=?,error_message=NULL,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(JSON.stringify(output),generationId,userId).run();
  console.log(JSON.stringify({event:"background_voice_completed",generation_id:generationId,project_id:projectId}));message.ack();
 }catch(error){
  const detail=String(error?.message||error).slice(0,500),attempts=Number(message.attempts||1);
  console.error(JSON.stringify({event:"background_voice_attempt_failed",generation_id:generationId,attempts,error:detail}));
  if(attempts>=3){await env.DB.prepare("UPDATE generations SET status='failed',error_message=?,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(detail,generationId,userId).run();message.ack();}
  else message.retry({delaySeconds:Math.min(60,attempts*15)});
 }
}

function decodeBase64(value) {
  const normalized=String(value||"").replace(/-/g,"+").replace(/_/g,"/");
  const padded=normalized+"=".repeat((4-normalized.length%4)%4);
  return Uint8Array.from(atob(padded),ch=>ch.charCodeAt(0));
}
async function tokenCryptoKey(env) {
  const raw=decodeBase64(env.PUBLISH_TOKEN_ENCRYPTION_KEY||"");
  if(raw.length!==32)throw new Error("PUBLISH_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return crypto.subtle.importKey("raw",raw,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
async function encryptSocialToken(env,value) {
  const iv=crypto.getRandomValues(new Uint8Array(12)),key=await tokenCryptoKey(env);
  const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,encoder.encode(String(value||"")));
  const combined=new Uint8Array(iv.length+encrypted.byteLength);combined.set(iv);combined.set(new Uint8Array(encrypted),iv.length);
  return base64url(combined);
}
async function socialOAuthCallback(request,env,platform) {
  const url=new URL(request.url),state=url.searchParams.get("state")||"",code=url.searchParams.get("code")||"";
  const fail=(message)=>Response.redirect((env.APP_ORIGIN||"https://facelesslab.pages.dev")+"/#publishing?oauth_error="+encodeURIComponent(message),302);
  if(url.searchParams.get("error"))return fail("Authorization was cancelled.");
  if(!state||!code)return fail("The authorization response is missing its state or code.");
  const stateRow=await env.DB.prepare("SELECT user_id,platform,expires_at FROM oauth_states WHERE state=?").bind(state).first();
  await env.DB.prepare("DELETE FROM oauth_states WHERE state=?").bind(state).run();
  if(!stateRow||stateRow.platform!==platform||Number(stateRow.expires_at)<Math.floor(Date.now()/1000))return fail("Authorization expired. Please connect again.");
  const redirectUri=(env.APP_ORIGIN||"https://facelesslab.pages.dev")+"/api/publishing/oauth/"+platform+"/callback";
  let tokenData={},profile={},scopes="";
  if(platform==="youtube"){
    if(!env.YOUTUBE_CLIENT_ID||!env.YOUTUBE_CLIENT_SECRET)return fail("YouTube OAuth credentials are not configured yet.");
    const body=new URLSearchParams({code,client_id:env.YOUTUBE_CLIENT_ID,client_secret:env.YOUTUBE_CLIENT_SECRET,redirect_uri:redirectUri,grant_type:"authorization_code"});
    const response=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body});
    tokenData=await response.json().catch(()=>({}));
    if(!response.ok||!tokenData.access_token)return fail(tokenData.error_description||tokenData.error||"YouTube token exchange failed.");
    const p=await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",{headers:{authorization:"Bearer "+tokenData.access_token}});
    const pd=await p.json().catch(()=>({}));
    if(!p.ok||!pd.items?.[0])return fail("Could not read the authorized YouTube channel.");
    profile={id:pd.items[0].id,name:pd.items[0].snippet?.title||"YouTube channel"};
    scopes=tokenData.scope||"https://www.googleapis.com/auth/youtube.upload";
  }else{
    if(!env.TIKTOK_CLIENT_KEY||!env.TIKTOK_CLIENT_SECRET)return fail("TikTok OAuth credentials are not configured yet.");
    const body=new URLSearchParams({client_key:env.TIKTOK_CLIENT_KEY,client_secret:env.TIKTOK_CLIENT_SECRET,code,grant_type:"authorization_code",redirect_uri:redirectUri});
    const response=await fetch("https://open.tiktokapis.com/v2/oauth/token/",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body});
    tokenData=await response.json().catch(()=>({}));
    if(!response.ok||!tokenData.access_token)return fail(tokenData.error_description||tokenData.error||"TikTok token exchange failed.");
    const p=await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",{headers:{authorization:"Bearer "+tokenData.access_token}});
    const pd=await p.json().catch(()=>({}));
    if(!p.ok||!pd.data?.user?.open_id)return fail("Could not read the authorized TikTok profile.");
    profile={id:pd.data.user.open_id,name:pd.data.user.display_name||"TikTok creator"};
    scopes=tokenData.scope||"";
  }
  try{
    const accessEnc=await encryptSocialToken(env,tokenData.access_token);
    const refreshEnc=tokenData.refresh_token?await encryptSocialToken(env,tokenData.refresh_token):null;
    await env.DB.prepare("INSERT INTO social_connections (id,user_id,platform,platform_user_id,display_name,access_token_enc,refresh_token_enc,access_token_expires_at,refresh_token_expires_at,scopes,status) VALUES (?,?,?,?,?,?,?,?,?,?, 'active') ON CONFLICT(user_id,platform,platform_user_id) DO UPDATE SET display_name=excluded.display_name,access_token_enc=excluded.access_token_enc,refresh_token_enc=COALESCE(excluded.refresh_token_enc,social_connections.refresh_token_enc),access_token_expires_at=excluded.access_token_expires_at,refresh_token_expires_at=excluded.refresh_token_expires_at,scopes=excluded.scopes,status='active',updated_at=unixepoch()")
      .bind(crypto.randomUUID(),stateRow.user_id,platform,profile.id,profile.name,accessEnc,refreshEnc,Math.floor(Date.now()/1000)+Number(tokenData.expires_in||3600),tokenData.refresh_expires_in?Math.floor(Date.now()/1000)+Number(tokenData.refresh_expires_in):null,scopes).run();
  }catch(error){console.error("social_token_store_failed",platform,String(error));return fail("Could not securely save the account. Check the publishing encryption key.");}
  return Response.redirect((env.APP_ORIGIN||"https://facelesslab.pages.dev")+"/#publishing?connected="+platform,302);
}

async function decryptSocialToken(env,value) {
  const bytes=decodeBase64(value),key=await tokenCryptoKey(env);
  const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes.slice(0,12)},key,bytes.slice(12));
  return new TextDecoder().decode(plain);
}
async function getFreshSocialAccessToken(env,connection) {
  const now=Math.floor(Date.now()/1000);
  if(Number(connection.access_token_expires_at||0)>now+300)return decryptSocialToken(env,connection.access_token_enc);
  if(!connection.refresh_token_enc)throw new Error("Reconnect this social account to restore upload access.");
  const refresh=await decryptSocialToken(env,connection.refresh_token_enc);
  const youtube=connection.platform==="youtube";
  const body=youtube?{client_id:env.YOUTUBE_CLIENT_ID,client_secret:env.YOUTUBE_CLIENT_SECRET,refresh_token:refresh,grant_type:"refresh_token"}:{client_key:env.TIKTOK_CLIENT_KEY,client_secret:env.TIKTOK_CLIENT_SECRET,refresh_token:refresh,grant_type:"refresh_token"};
  const response=await fetch(youtube?"https://oauth2.googleapis.com/token":"https://open.tiktokapis.com/v2/oauth/token/",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(body)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.access_token)throw new Error(data.error_description||data.error||"Social account token refresh failed.");
  await env.DB.prepare("UPDATE social_connections SET access_token_enc=?,refresh_token_enc=?,access_token_expires_at=?,refresh_token_expires_at=?,status='active',updated_at=unixepoch() WHERE id=?")
   .bind(await encryptSocialToken(env,data.access_token),data.refresh_token?await encryptSocialToken(env,data.refresh_token):connection.refresh_token_enc,now+Number(data.expires_in||3600),data.refresh_expires_in?now+Number(data.refresh_expires_in):connection.refresh_token_expires_at,connection.id).run();
  return data.access_token;
}
async function processPublishQueueMessage(message,env) {
 const id=message.body?.job_id;if(!id)return;
 const job=await env.DB.prepare("SELECT * FROM publish_jobs WHERE id=? AND status='queued'").bind(id).first();if(!job)return;
 const connection=await env.DB.prepare("SELECT * FROM social_connections WHERE id=? AND user_id=? AND status='active'").bind(job.connection_id,job.user_id).first();
 if(!connection)throw new Error("Connected social account not found.");
 const object=await env.MEDIA.get("users/"+job.user_id+"/rendered-backups/"+job.backup_id+".mp4");if(!object)throw new Error("Cloud backup not found.");
 await env.DB.prepare("UPDATE publish_jobs SET status='uploading',error_message=NULL,updated_at=unixepoch() WHERE id=?").bind(id).run();
 try{
  const access=await getFreshSocialAccessToken(env,connection),size=Number(object.size||0);if(!size)throw new Error("MP4 file is empty.");
  if(job.platform==="youtube"){
   const tags=(String(job.hashtags||"").match(/#[\\p{L}\\p{N}_]+/gu)||[]).map(x=>x.slice(1)).slice(0,30);
   const metadata={snippet:{title:String(job.title||"FacelessLab video").slice(0,100),description:String(job.description||"")+(job.hashtags?"\\n\\n"+job.hashtags:""),tags,categoryId:"24"},status:{privacyStatus:["public","unlisted","private"].includes(job.privacy)?job.privacy:"private",selfDeclaredMadeForKids:false}};
   const init=await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",{method:"POST",headers:{authorization:"Bearer "+access,"content-type":"application/json; charset=UTF-8","x-upload-content-type":"video/mp4","x-upload-content-length":String(size)},body:JSON.stringify(metadata)});
   if(!init.ok)throw new Error("YouTube upload setup failed: "+(await init.text()).slice(0,300));
   const location=init.headers.get("location");if(!location)throw new Error("YouTube did not return an upload URL.");
   const uploaded=await fetch(location,{method:"PUT",headers:{"content-type":"video/mp4","content-length":String(size)},body:object.body});
   const result=await uploaded.json().catch(()=>({}));if(!uploaded.ok||!result.id)throw new Error("YouTube upload failed: "+JSON.stringify(result.error||result).slice(0,300));
   await env.DB.prepare("UPDATE publish_jobs SET status='published',provider_post_id=?,provider_url=?,updated_at=unixepoch() WHERE id=?").bind(result.id,"https://www.youtube.com/shorts/"+result.id,id).run();
  }else{
   if(size<5*1024*1024)throw new Error("TikTok direct upload requires an MP4 of at least 5 MB.");
   const info=await fetch("https://open.tiktokapis.com/v2/post/publish/creator_info/query/",{method:"POST",headers:{authorization:"Bearer "+access,"content-type":"application/json"},body:"{}"});
   const creator=await info.json().catch(()=>({})),privacy=job.privacy==="public"?"PUBLIC_TO_EVERYONE":"SELF_ONLY";
   if(!info.ok||creator.error?.code!=="ok"||!(creator.data?.privacy_level_options||[]).includes(privacy))throw new Error("TikTok does not allow the selected privacy setting.");
   const chunkSize=Math.min(64*1024*1024,Math.max(5*1024*1024,size)),chunks=Math.ceil(size/chunkSize);
   const init=await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/",{method:"POST",headers:{authorization:"Bearer "+access,"content-type":"application/json"},body:JSON.stringify({post_info:{title:(job.title+" "+(job.hashtags||"")).slice(0,2200),privacy_level:privacy,is_aigc:true},source_info:{source:"FILE_UPLOAD",video_size:size,chunk_size:chunkSize,total_chunk_count:chunks}})});
   const started=await init.json().catch(()=>({}));if(!init.ok||started.error?.code!=="ok"||!started.data?.upload_url)throw new Error("TikTok upload setup failed: "+(started.error?.message||"unknown error"));
   const bytes=await object.arrayBuffer();
   for(let i=0;i<chunks;i++){const start=i*chunkSize,end=Math.min(size,start+chunkSize),part=bytes.slice(start,end);const sent=await fetch(started.data.upload_url,{method:"PUT",headers:{"content-type":"video/mp4","content-length":String(part.byteLength),"content-range":"bytes "+start+"-"+(end-1)+"/"+size},body:part});if(!sent.ok)throw new Error("TikTok upload failed on chunk "+(i+1)+".");}
   await env.DB.prepare("UPDATE publish_jobs SET status='processing',provider_post_id=?,updated_at=unixepoch() WHERE id=?").bind(started.data.publish_id,id).run();
   const check=await fetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/",{method:"POST",headers:{authorization:"Bearer "+access,"content-type":"application/json"},body:JSON.stringify({publish_id:started.data.publish_id})});
   const status=await check.json().catch(()=>({}));if(status.data?.status==="PUBLISH_COMPLETE")await env.DB.prepare("UPDATE publish_jobs SET status='published',updated_at=unixepoch() WHERE id=?").bind(id).run();else if(status.data?.status==="FAILED")throw new Error(status.data.fail_reason||"TikTok rejected the video.");
  }
 }catch(error){await env.DB.prepare("UPDATE publish_jobs SET status='failed',error_message=?,updated_at=unixepoch() WHERE id=?").bind(String(error?.message||error).slice(0,700),id).run();throw error;}
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") return new Response(null, { status: 204 });

  if (path === "/health" && method === "GET") {
    let database = false;
    let storage = false;
    const queue = Boolean(env.JOBS && typeof env.JOBS.send === "function");
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      database = true;
    } catch {}
    try {
      await env.MEDIA.list({ limit: 1 });
      storage = true;
    } catch {}
    const ok = database && storage && queue;
    return json({
      ok,
      service: "FacelessLab API",
      version: "0.9.0",
      checks: { database, storage, queue },
      timestamp: new Date().toISOString()
    }, ok ? 200 : 503);
  }

  if (path === "/" && method === "GET") {
    return json({
      name: env.APP_NAME || "FacelessLab",
      version: "0.8.0",
      endpoints: ["/health", "/api/auth/register", "/api/auth/login", "/api/auth/logout", "/api/me", "/api/projects", "/api/projects/:id/generate-script", "/api/projects/:id/script", "/api/projects/:id/generate-voice", "/api/projects/:id/voice", "/api/projects/:id/voice/audio", "/api/projects/:id/visuals", "/api/projects/:id/visuals/:generation_id/image", "/api/projects/:id/continue", "/api/projects/:id/subtitles"]
    });
  }

  if (path === "/api/auth/register" && method === "POST") {
    const body = await request.json().catch(() => null);
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");
    const displayName = String(body?.display_name || "").trim().slice(0, 80);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: "Enter a valid email address." }, 400);
    if (password.length < 8 || password.length > 128) return json({ ok: false, error: "Password must be 8–128 characters." }, 400);

    const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (existing) return json({ ok: false, error: "An account with this email already exists." }, 409);

    const id = crypto.randomUUID();
    const { salt, hash } = await hashPassword(password);
    const passwordHash = `pbkdf2-sha256:100000:${salt}:${hash}`;
    const now = Math.floor(Date.now() / 1000);
    const token = randomToken();
    const tokenHash = await sha256(token);
    const expires = now + SESSION_DAYS * 86400;

    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)").bind(id, email, passwordHash, displayName || email.split("@")[0]),
      env.DB.prepare("INSERT INTO wallets (user_id, balance) VALUES (?, 0)").bind(id),
      env.DB.prepare("INSERT INTO user_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)").bind(crypto.randomUUID(), id, tokenHash, expires)
    ]);
    const user = await env.DB.prepare("SELECT id, email, display_name, role FROM users WHERE id = ?").bind(id).first();
    return json({ ok: true, token, user: publicUser(user), expires_at: expires }, 201);
  }

  if (path === "/api/auth/login" && method === "POST") {
    const body = await request.json().catch(() => null);
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");
    const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
    if (!user || user.status !== "active" || !user.password_hash) return json({ ok: false, error: "Invalid email or password." }, 401);

    const parts = user.password_hash.split(":");
    if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return json({ ok: false, error: "Account password format is unsupported." }, 500);
    const derived = await hashPassword(password, parts[2]);
    if (derived.hash !== parts[3]) return json({ ok: false, error: "Invalid email or password." }, 401);

    const token = randomToken();
    const tokenHash = await sha256(token);
    const now = Math.floor(Date.now() / 1000);
    const expires = now + SESSION_DAYS * 86400;
    await env.DB.prepare("INSERT INTO user_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .bind(crypto.randomUUID(), user.id, tokenHash, expires).run();
    return json({ ok: true, token, user: publicUser(user), expires_at: expires });
  }

  if (path === "/api/auth/logout" && method === "POST") {
    const auth = request.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token) await env.DB.prepare("DELETE FROM user_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return json({ ok: true });
  }

  const socialCallback=path.match(new RegExp("^/api/publishing/oauth/(youtube|tiktok)/callback$"));
  if(socialCallback&&method==="GET")return socialOAuthCallback(request,env,socialCallback[1]);

  if (path.startsWith("/api/")) {
    const user = await getUser(request, env);
    if (!user) return json({ ok: false, error: "Authentication required." }, 401);
    if (path === "/api/profile" && method === "POST") {
      const body = await request.json().catch(() => null);
      const displayName = String(body?.display_name || "").trim();
      if (!displayName) return json({ ok: false, error: "Display name cannot be empty." }, 400);
      if (displayName.length > 80) return json({ ok: false, error: "Display name must be 80 characters or fewer." }, 400);
      await env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(displayName, user.id).run();
      const updated = await env.DB.prepare("SELECT id, email, display_name, role FROM users WHERE id = ?").bind(user.id).first();
      return json({ ok: true, user: publicUser(updated) });
    }

    if(path==="/api/publishing/connections"&&method==="GET"){
      const rows=await env.DB.prepare("SELECT id,platform,platform_user_id,display_name,status,scopes,access_token_expires_at,created_at FROM social_connections WHERE user_id=? ORDER BY platform").bind(user.id).all();
      return json({ok:true,connections:rows.results||[],configured:{youtube:Boolean(env.YOUTUBE_CLIENT_ID&&env.YOUTUBE_CLIENT_SECRET),tiktok:Boolean(env.TIKTOK_CLIENT_KEY&&env.TIKTOK_CLIENT_SECRET),encryption:Boolean(env.PUBLISH_TOKEN_ENCRYPTION_KEY)}});
    }
    const connectMatch=path.match(new RegExp("^/api/publishing/connect/(youtube|tiktok)$"));
    if(connectMatch&&method==="POST"){
      const platform=connectMatch[1],now=Math.floor(Date.now()/1000);
      if(platform==="youtube"&&(!env.YOUTUBE_CLIENT_ID||!env.YOUTUBE_CLIENT_SECRET))return json({ok:false,error:"YouTube OAuth credentials are not configured."},503);
      if(platform==="tiktok"&&(!env.TIKTOK_CLIENT_KEY||!env.TIKTOK_CLIENT_SECRET))return json({ok:false,error:"TikTok OAuth credentials are not configured."},503);
      if(!env.PUBLISH_TOKEN_ENCRYPTION_KEY)return json({ok:false,error:"Secure token encryption is not configured."},503);
      const state=randomToken(),redirectUri=(env.APP_ORIGIN||"https://facelesslab.pages.dev")+"/api/publishing/oauth/"+platform+"/callback";
      await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(now).run();
      await env.DB.prepare("INSERT INTO oauth_states (state,user_id,platform,expires_at) VALUES (?,?,?,?)").bind(state,user.id,platform,now+600).run();
      let target;
      if(platform==="youtube"){
        const u=new URL("https://accounts.google.com/o/oauth2/v2/auth");
        u.searchParams.set("client_id",env.YOUTUBE_CLIENT_ID);u.searchParams.set("redirect_uri",redirectUri);u.searchParams.set("response_type","code");u.searchParams.set("scope","https://www.googleapis.com/auth/youtube.upload");u.searchParams.set("access_type","offline");u.searchParams.set("prompt","consent");u.searchParams.set("state",state);target=u.toString();
      }else{
        const u=new URL("https://www.tiktok.com/v2/auth/authorize/");
        u.searchParams.set("client_key",env.TIKTOK_CLIENT_KEY);u.searchParams.set("redirect_uri",redirectUri);u.searchParams.set("response_type","code");u.searchParams.set("scope","user.info.basic,video.publish,video.upload");u.searchParams.set("state",state);target=u.toString();
      }
      return json({ok:true,authorization_url:target});
    }
    if(path==="/api/publishing/connections"&&method==="DELETE"){
      const body=await request.json().catch(()=>({})),id=String(body?.id||"");
      if(!id)return json({ok:false,error:"Connection ID is required."},400);
      await env.DB.prepare("DELETE FROM social_connections WHERE id=? AND user_id=?").bind(id,user.id).run();
      return json({ok:true});
    }
    if(path==="/api/publishing/jobs"&&method==="GET"){
      const rows=await env.DB.prepare("SELECT j.id,j.backup_id,j.platform,j.title,j.description,j.hashtags,j.privacy,j.scheduled_at,j.status,j.provider_post_id,j.provider_url,j.error_message,j.created_at,c.display_name AS account_name FROM publish_jobs j LEFT JOIN social_connections c ON c.id=j.connection_id WHERE j.user_id=? ORDER BY j.created_at DESC LIMIT 100").bind(user.id).all();
      return json({ok:true,jobs:rows.results||[]});
    }
    if(path==="/api/publishing/jobs"&&method==="POST"){
      const body=await request.json().catch(()=>null),backupId=String(body?.backup_id||""),platform=String(body?.platform||"");
      const title=String(body?.title||"").trim().slice(0,100),description=String(body?.description||"").trim().slice(0,5000),hashtags=String(body?.hashtags||"").trim().slice(0,1000);
      if(!/^[a-f0-9-]{36}$/i.test(backupId)||!["youtube","tiktok"].includes(platform)||!title)return json({ok:false,error:"Choose a cloud video, platform, and title."},400);
      const connection=await env.DB.prepare("SELECT id FROM social_connections WHERE user_id=? AND platform=? AND status='active' ORDER BY updated_at DESC LIMIT 1").bind(user.id,platform).first();
      if(!connection)return json({ok:false,error:"Connect your "+platform+" account before preparing a post."},409);
      const key="users/"+user.id+"/rendered-backups/"+backupId+".mp4",object=await env.MEDIA.head(key);
      if(!object)return json({ok:false,error:"Cloud video not found. Upload or render a video backup first."},404);
      const id=crypto.randomUUID();
      await env.DB.prepare("INSERT INTO publish_jobs (id,user_id,backup_id,platform,connection_id,title,description,hashtags,privacy,status) VALUES (?,?,?,?,?,?,?,?,?,'draft')").bind(id,user.id,backupId,platform,connection.id,title,description,hashtags,String(body?.privacy||"private")).run();
      return json({ok:true,job:{id,backup_id:backupId,platform,title,status:"draft"}},201);
    }
    const publishNowMatch=path.match(new RegExp("^/api/publishing/jobs/([a-f0-9-]+)/publish$","i"));
    if(publishNowMatch&&method==="POST"){
      const id=publishNowMatch[1],job=await env.DB.prepare("SELECT id,status FROM publish_jobs WHERE id=? AND user_id=?").bind(id,user.id).first();
      if(!job)return json({ok:false,error:"Publishing draft not found."},404);
      if(!["draft","failed"].includes(job.status))return json({ok:false,error:"This post is already in the publishing workflow."},409);
      if(!env.JOBS||typeof env.JOBS.send!=="function")return json({ok:false,error:"Publishing queue is unavailable."},503);
      await env.DB.prepare("UPDATE publish_jobs SET status='queued',error_message=NULL,updated_at=unixepoch() WHERE id=?").bind(id).run();
      try{await env.JOBS.send({type:"publish_video",job_id:id});}catch(error){await env.DB.prepare("UPDATE publish_jobs SET status='failed',error_message=?,updated_at=unixepoch() WHERE id=?").bind(String(error?.message||error).slice(0,500),id).run();throw error;}
      return json({ok:true,status:"queued"},202);
    }
    const publishJobMatch=path.match(new RegExp("^/api/publishing/jobs/([a-f0-9-]+)$","i"));
    if(publishJobMatch&&method==="DELETE"){
      await env.DB.prepare("DELETE FROM publish_jobs WHERE id=? AND user_id=? AND status IN ('draft','failed','cancelled')").bind(publishJobMatch[1],user.id).run();
      return json({ok:true});
    }
    const backupCollection = "/api/video-backups";
    if (path === backupCollection && method === "GET") {
      const prefix = "users/" + user.id + "/rendered-backups/";
      const listed = await env.MEDIA.list({ prefix, limit: 1000, include: ["customMetadata"] });
      const backups = (listed.objects || []).map(object => ({ id: object.key.slice(prefix.length).replace(/\.mp4$/i, ""), title: object.customMetadata?.title || "FacelessLab video", size: object.size, created_at: object.uploaded ? new Date(object.uploaded).toISOString() : null, duration: Number(object.customMetadata?.duration || 0), quality: Number(object.customMetadata?.quality || 0) })).sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
      const listed_bytes = backups.reduce((total, backup) => total + Number(backup.size || 0), 0);
      return json({ ok: true, backups, count: backups.length, listed_bytes, truncated: Boolean(listed.truncated) });
    }
    if (path === backupCollection && method === "POST") {
      const contentLength = Number(request.headers.get("content-length") || 0);
      const maxBytes = 90 * 1024 * 1024;
      if (!request.body) return json({ ok: false, error: "MP4 file body is missing." }, 400);
      if (contentLength > maxBytes) return json({ ok: false, error: "Cloud backup supports MP4 files up to 90 MB per file." }, 413);
      const id = crypto.randomUUID();
      const prefix = "users/" + user.id + "/rendered-backups/";
      const encodedTitle = String(request.headers.get("x-video-title") || "FacelessLab video");
      let title = encodedTitle;
      try { title = decodeURIComponent(encodedTitle); } catch {}
      title = title.slice(0, 160);
      const duration = Math.max(0, Number(request.headers.get("x-video-duration") || 0));
      const quality = Math.max(0, Number(request.headers.get("x-video-quality") || 0));
      let object;
      try {
        // Pass the original request stream directly to R2. Wrapping it in a
        // TransformStream can hide its known length and cause R2 to reject the upload.
        object = await env.MEDIA.put(prefix + id + ".mp4", request.body, {
          httpMetadata: { contentType: "video/mp4", cacheControl: "private, no-store" },
          customMetadata: { title, duration: String(duration), quality: String(quality), ownerId: user.id }
        });
      } catch (error) {
        console.error(JSON.stringify({ event: "cloud_backup_upload_failed", user_id: user.id, size: contentLength || null, error: String(error?.message || error).slice(0, 400) }));
        return json({ ok: false, error: "Cloud storage rejected the upload. Please retry once; your local video is unchanged." }, 502);
      }
      return json({ ok: true, backup: { id, title, size: object.size, duration, quality } }, 201);
    }
    const backupMatch = path.match(/^\/api\/video-backups\/([a-f0-9-]+)$/i);
    if (backupMatch && method === "GET") {
      const key = "users/" + user.id + "/rendered-backups/" + backupMatch[1] + ".mp4";
      const object = await env.MEDIA.get(key);
      if (!object) return json({ ok: false, error: "Cloud backup not found." }, 404);
      return new Response(object.body, { headers: { "content-type": "video/mp4", "content-length": String(object.size), "content-disposition": "attachment; filename=facelesslab-video.mp4", "cache-control": "private, no-store", "x-video-title": encodeURIComponent(object.customMetadata?.title || "FacelessLab video"), "x-video-duration": String(object.customMetadata?.duration || 0), "x-video-quality": String(object.customMetadata?.quality || 0), "access-control-expose-headers": "x-video-title, x-video-duration, x-video-quality" } });
    }
    if (backupMatch && method === "DELETE") {
      const key = "users/" + user.id + "/rendered-backups/" + backupMatch[1] + ".mp4";
      await env.MEDIA.delete(key);
      return json({ ok: true });
    }
    if (path === "/api/me" && method === "GET") {
      const wallet = await env.DB.prepare("SELECT balance FROM wallets WHERE user_id = ?").bind(user.id).first();
      return json({ ok: true, user: publicUser(user), points: user.role === "admin" ? null : (wallet?.balance ?? 0), unlimited_points: user.role === "admin" });
    }


    const voiceMatch = path.match(/^\/api\/projects\/([a-f0-9-]+)\/generate-voice$/i);
    if(voiceMatch&&method==="POST"){
      const projectId=voiceMatch[1],project=await env.DB.prepare("SELECT id,language,style FROM projects WHERE id=? AND user_id=?").bind(projectId,user.id).first();
      if(!project)return json({ok:false,error:"Project not found."},404);
      if(!env.JOBS||typeof env.JOBS.send!=="function")return json({ok:false,error:"Background job queue is not configured yet."},503);
      if(!env.AI||typeof env.AI.run!=="function")return json({ok:false,error:"Workers AI text-to-speech is unavailable."},503);
      const scriptRow=await env.DB.prepare("SELECT id,output_json FROM generations WHERE project_id=? AND user_id=? AND stage='script' AND status='completed' ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id).first();
      if(!scriptRow)return json({ok:false,error:"Generate a script before creating the voice-over."},409);
      const script=JSON.parse(scriptRow.output_json),narration=String(script.narration||(script.scenes||[]).map(s=>s.voiceover||"").join(" ")).trim();
      if(!narration)return json({ok:false,error:"The saved script has no narration text."},422);
      if(narration.length>4500)return json({ok:false,error:"Narration is too long. Keep it under 4,500 characters."},413);
      const pending=await env.DB.prepare("SELECT id,status FROM generations WHERE project_id=? AND user_id=? AND stage='voice' AND json_extract(input_json,'$.script_generation_id')=? AND status IN ('queued','processing') ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id,scriptRow.id).first();
      if(pending)return json({ok:true,queued:true,generation_id:pending.id,status:pending.status},202);
      const generationId=crypto.randomUUID(),model="@cf/myshell-ai/melotts",provider="cloudflare-workers-ai";
      const input={provider,model,language:"en",script_generation_id:scriptRow.id,characters:narration.length,billing_note:"Workers AI MeloTTS pricing"};
      await env.DB.prepare("INSERT INTO generations (id,project_id,user_id,stage,status,input_json) VALUES (?,?,?,'voice','queued',?)").bind(generationId,projectId,user.id,JSON.stringify(input)).run();
      try{await env.JOBS.send({type:"generate_voice",generation_id:generationId,project_id:projectId,user_id:user.id});}
      catch(error){await env.DB.prepare("UPDATE generations SET status='failed',error_message=?,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(String(error.message||error).slice(0,500),generationId,user.id).run();throw error;}
      return json({ok:true,queued:true,generation_id:generationId,status:"queued"},202);
    }

    const voiceInfoMatch = path.match(/^\/api\/projects\/([a-f0-9-]+)\/voice$/i);
    if(voiceInfoMatch&&method==="GET"){
      const projectId=voiceInfoMatch[1],project=await env.DB.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").bind(projectId,user.id).first();
      if(!project)return json({ok:false,error:"Project not found."},404);
      const script=await env.DB.prepare("SELECT id FROM generations WHERE project_id=? AND user_id=? AND stage='script' AND status='completed' ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id).first();
      if(!script)return json({ok:true,voice:null,status:"empty"});
      const row=await env.DB.prepare("SELECT id,status,output_json,error_message,created_at FROM generations WHERE project_id=? AND user_id=? AND stage='voice' AND json_extract(input_json,'$.script_generation_id')=? ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id,script.id).first();
      return json({ok:true,voice:row?.status==="completed"&&row.output_json?{generation_id:row.id,...JSON.parse(row.output_json),created_at:row.created_at}:null,generation_id:row?.id||null,status:row?.status||"empty",error:row?.error_message||null});
    }

    const voiceAudioMatch = path.match(/^\/api\/projects\/([a-f0-9-]+)\/voice\/audio$/i);
    if (voiceAudioMatch && method === "GET") {
      const projectId=voiceAudioMatch[1];
      const project=await env.DB.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").bind(projectId,user.id).first();
      if(!project) return json({ok:false,error:"Project not found."},404);
      const voice=await env.DB.prepare("SELECT output_json FROM generations WHERE project_id=? AND user_id=? AND stage='voice' AND status='completed' AND json_extract(input_json, '$.script_generation_id') = (SELECT id FROM generations WHERE project_id=? AND user_id=? AND stage='script' AND status='completed' ORDER BY created_at DESC LIMIT 1) ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id,projectId,user.id).first();
      if(!voice) return json({ok:false,error:"No voice-over has been generated yet."},404);
      const meta=JSON.parse(voice.output_json);
      const object=await env.MEDIA.get(meta.object_key);
      if(!object) return json({ok:false,error:"Audio file is missing from storage."},404);
      const mimeType = ["audio/wav","audio/mpeg"].includes(meta.mime_type) ? meta.mime_type : "audio/mpeg";
      const extension = mimeType === "audio/wav" ? "wav" : "mp3";
      return new Response(object.body,{headers:{"content-type":mimeType,"content-length":String(meta.bytes),"content-disposition":'inline; filename="facelesslab-voice.'+extension+'"',"cache-control":"private, no-store"}});
    }

    const scriptMatch = path.match(/^\/api\/projects\/([a-f0-9-]+)\/generate-script$/i);
    if (scriptMatch && method === "POST") {
      const projectId=scriptMatch[1];
      const project=await env.DB.prepare("SELECT id,user_id,title,topic,language,duration_seconds,style,parent_project_id,episode_number,continuity_json FROM projects WHERE id=? AND user_id=?").bind(projectId,user.id).first();
      if(!project)return json({ok:false,error:"Project not found."},404);
      if(!env.JOBS||typeof env.JOBS.send!=="function")return json({ok:false,error:"Background queue unavailable."},503);
      if(project.language!=="en"){await env.DB.prepare("UPDATE projects SET language='en',updated_at=unixepoch() WHERE id=? AND user_id=?").bind(projectId,user.id).run();project.language="en";}
      const latest=await env.DB.prepare("SELECT id,status,output_json,input_json,error_message FROM generations WHERE project_id=? AND user_id=? AND stage='script' ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id).first();
      if(latest?.status==="completed"&&latest.output_json){
        const cachedScript=JSON.parse(latest.output_json),cachedInput=JSON.parse(latest.input_json||"{}");
        const cachedWords=String(cachedScript.narration||"").trim().split(/\s+/).filter(Boolean).length;
        const expectedWords=Math.round((Number(project.duration_seconds)||45)*2.25);
        if(cachedInput.language==="en"&&cachedWords>=Math.round(expectedWords*.92))return json({ok:true,cached:true,generation_id:latest.id,script:cachedScript,status:"completed"});
      }
      if(latest&&["queued","processing"].includes(latest.status))return json({ok:true,queued:true,generation_id:latest.id,status:latest.status},202);
      const generationId=crypto.randomUUID();
      const input={topic:project.topic,language:project.language,duration_seconds:project.duration_seconds,style:project.style,queued_at:new Date().toISOString()};
      await env.DB.prepare("INSERT INTO generations (id,project_id,user_id,stage,status,input_json) VALUES (?,?,?,'script','queued',?)").bind(generationId,projectId,user.id,JSON.stringify(input)).run();
      await env.DB.prepare("UPDATE projects SET status='queued',updated_at=unixepoch() WHERE id=? AND user_id=?").bind(projectId,user.id).run();
      try{await env.JOBS.send({type:"generate_script",generation_id:generationId,project_id:projectId,user_id:user.id});}
      catch(error){
        await env.DB.prepare("UPDATE generations SET status='failed',error_message=?,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(String(error.message||error).slice(0,500),generationId,user.id).run();
        await env.DB.prepare("UPDATE projects SET status='failed',updated_at=unixepoch() WHERE id=? AND user_id=?").bind(projectId,user.id).run();
        throw error;
      }
      return json({ok:true,queued:true,generation_id:generationId,status:"queued"},202);
    }
    const characterReferenceImageMatch=path.match(/^\/api\/projects\/([a-f0-9-]+)\/characters\/([a-z0-9-]+)\/reference\/image$/i);
    if(characterReferenceImageMatch&&method==="GET"){
      const projectId=characterReferenceImageMatch[1],characterId=characterReferenceImageMatch[2];
      const project=await env.DB.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").bind(projectId,user.id).first();
      if(!project)return json({ok:false,error:"Project not found."},404);
      const row=await env.DB.prepare("SELECT output_json FROM generations WHERE project_id=? AND user_id=? AND stage='script' AND status='completed' ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id).first();
      if(!row)return json({ok:false,error:"Script not found."},404);
      const character=(JSON.parse(row.output_json||"{}").characters||[]).find(c=>c.id===characterId);
      if(!character?.character_reference_object_key)return json({ok:false,error:"This character has no reference image yet."},404);
      const object=await env.MEDIA.get(character.character_reference_object_key);
      if(!object)return json({ok:false,error:"Character reference image is missing from R2."},404);
      return new Response(object.body,{headers:{"content-type":"image/png","cache-control":"private, no-store"}});
    }
    const characterReferenceMatch=path.match(/^\/api\/projects\/([a-f0-9-]+)\/characters\/([a-z0-9-]+)\/reference$/i);
    if(characterReferenceMatch&&method==="POST"){
      const projectId=characterReferenceMatch[1],characterId=characterReferenceMatch[2];
      const project=await env.DB.prepare("SELECT id,style FROM projects WHERE id=? AND user_id=?").bind(projectId,user.id).first();
      if(!project)return json({ok:false,error:"Project not found."},404);
      if(!env.AI||typeof env.AI.run!=="function"||!env.MEDIA)return json({ok:false,error:"Workers AI or R2 storage is unavailable."},503);
      const row=await env.DB.prepare("SELECT id,output_json FROM generations WHERE project_id=? AND user_id=? AND stage='script' AND status='completed' ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id).first();
      if(!row)return json({ok:false,error:"Generate a script before creating character references."},409);
      const script=JSON.parse(row.output_json||"{}"),character=(script.characters||[]).find(c=>c.id===characterId);
      if(!character)return json({ok:false,error:"Character profile not found."},404);
      const generationId=crypto.randomUUID();
      const anime=String(project.style||"").toLowerCase()==="anime";
      const prompt=[
        anime?"Premium Japanese 2D anime character design reference, hand-drawn clean linework, cinematic cel shading, polished professional animation model sheet.":"Professional cinematic character design reference, realistic anatomy, natural materials and detailed production design.",
        "Create ONE individual character only. Full body, standing neutral relaxed three-quarter view, entire head and feet visible, centered, clear silhouette, simple uncluttered neutral studio background, soft even lighting, highly readable face and clothing.",
        "CHARACTER NAME: "+String(character.name||"").slice(0,80)+". ROLE: "+String(character.role||"").slice(0,140)+".",
        "LOCKED VISUAL IDENTITY: "+String(character.visual_identity||"").slice(0,600)+".",
        "SIGNATURE OUTFIT: "+String(character.signature_outfit||"").slice(0,350)+".",
        "DISTINCTIVE FEATURES: "+String(character.distinctive_features||"").slice(0,350)+".",
        "This is a reusable identity reference, not a story scene. Preserve exact face, hairstyle, eye design, age appearance, body proportions, outfit colors and signature accessories. No other people, no multiple views, no turnaround grid, no text, labels, logos, watermark, props obscuring the body."
      ].join(" ").slice(0,1900);
      await env.DB.prepare("INSERT INTO generations (id,project_id,user_id,stage,status,input_json) VALUES (?,?,?,'character_reference','processing',?)").bind(generationId,projectId,user.id,JSON.stringify({character_id:characterId,character_name:character.name,model:"@cf/black-forest-labs/flux-1-schnell"})).run();
      try{
        const result=await env.AI.run("@cf/black-forest-labs/flux-1-schnell",{prompt,steps:4});
        const value=typeof result==="string"?result:result?.image;
        let bytes;
        if(typeof value==="string"){const binary=atob(value),out=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)out[i]=binary.charCodeAt(i);bytes=out;}
        else if(value instanceof Uint8Array)bytes=value;
        else if(value instanceof ArrayBuffer)bytes=new Uint8Array(value);
        else if(ArrayBuffer.isView(value))bytes=new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
        else throw new Error("Image model returned an unsupported character reference.");
        if(!bytes?.byteLength)throw new Error("Image model returned an empty character reference.");
        const objectKey="users/"+user.id+"/projects/"+projectId+"/character-references/"+characterId+".png";
        await env.MEDIA.put(objectKey,bytes,{httpMetadata:{contentType:"image/png",cacheControl:"private, max-age=3600"},customMetadata:{userId:user.id,projectId,characterId,generationId}});
        character.character_reference_object_key=objectKey;
        character.character_reference_generated_at=new Date().toISOString();
        await env.DB.prepare("UPDATE generations SET output_json=?,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(JSON.stringify(script),row.id,user.id).run();
        const output={character_id:characterId,character_name:character.name,object_key:objectKey,mime_type:"image/png",bytes:bytes.byteLength,model:"@cf/black-forest-labs/flux-1-schnell"};
        await env.DB.prepare("UPDATE generations SET status='completed',output_json=?,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(JSON.stringify(output),generationId,user.id).run();
        return json({ok:true,character:{...character,reference_url:"/api/projects/"+projectId+"/characters/"+characterId+"/reference/image"}},201);
      }catch(error){
        await env.DB.prepare("UPDATE generations SET status='failed',error_message=?,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(String(error.message||error).slice(0,500),generationId,user.id).run();
        const message=String(error.message||"Character reference generation failed.");
        return json({ok:false,error:message},/limit|quota|billing|exceeded/i.test(message)?429:502);
      }
    }
    const charactersMatch=path.match(/^\/api\/projects\/([a-f0-9-]+)\/characters$/i);
    if(charactersMatch&&method==="POST"){
      const projectId=charactersMatch[1];
      try{
        const project=await env.DB.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").bind(projectId,user.id).first();
        if(!project)return json({ok:false,error:"Project not found."},404);
        const body=await request.json().catch(()=>null);
        if(!body||!Array.isArray(body.characters))return json({ok:false,error:"Character profile data is missing or invalid. Please reload and try again."},400);
        const characters=body.characters.filter(c=>c&&typeof c==="object"&&!Array.isArray(c));
        if(characters.length>8)return json({ok:false,error:"A project can have up to 8 character profiles."},400);
        if(!characters.length)return json({ok:false,error:"No character profiles were provided. Nothing was changed."},400);
        const row=await env.DB.prepare("SELECT id,output_json FROM generations WHERE project_id=? AND user_id=? AND stage='script' AND status='completed' ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id).first();
        if(!row)return json({ok:false,error:"Generate a script before editing character profiles."},409);
        let script;
        try{script=JSON.parse(row.output_json||"{}");}catch{throw new Error("The saved script data is damaged. Your character edits were not saved.");}
        if(!script||typeof script!=="object"||Array.isArray(script))throw new Error("The saved script data is invalid. Your character edits were not saved.");
        const previousCharacters=new Map((Array.isArray(script.characters)?script.characters:[]).filter(c=>c&&typeof c==="object").map(c=>[String(c.id||""),c]));
        const normalized=characters.map((c,i)=>{
          const id=String(c.id||("character-"+(i+1))).toLowerCase().replace(/[^a-z0-9-]+/g,"-").replace(/^-|-$/g,"").slice(0,80)||("character-"+(i+1));
          const previous=previousCharacters.get(id)||{};
          const next={...previous,id,name:String(c.name||"").trim().slice(0,80),role:String(c.role||"").trim().slice(0,180),visual_identity:String(c.visual_identity||"").trim().slice(0,600),signature_outfit:String(c.signature_outfit||"").trim().slice(0,350),distinctive_features:String(c.distinctive_features||"").trim().slice(0,350)};
          if(next.visual_identity!==String(previous.visual_identity||"")||next.signature_outfit!==String(previous.signature_outfit||"")||next.distinctive_features!==String(previous.distinctive_features||"")){delete next.character_reference_object_key;delete next.character_reference_generated_at;}
          return next;
        }).filter(c=>c.name&&c.visual_identity);
        if(!normalized.length)return json({ok:false,error:"Each character needs both a name and a visual identity."},400);
        script.characters=normalized;
        const saved=await env.DB.prepare("UPDATE generations SET output_json=?,updated_at=unixepoch() WHERE id=? AND project_id=? AND user_id=? AND stage='script'").bind(JSON.stringify(script),row.id,projectId,user.id).run();
        if(Number(saved.meta?.changes||0)<1)return json({ok:false,error:"The character profiles could not be written. Please reload the project and try again."},409);
        return json({ok:true,characters:script.characters});
      }catch(error){
        console.error(JSON.stringify({event:"save_character_profiles_failed",project_id:projectId,error:String(error?.message||error).slice(0,500)}));
        return json({ok:false,error:"Could not save character profiles: "+String(error?.message||"database error").slice(0,240)},500);
      }
    }

    const visualImageMatch = path.match(/^\/api\/projects\/([a-f0-9-]+)\/visuals\/([a-f0-9-]+)\/image$/i);
    if (visualImageMatch && method === "GET") {
      const projectId=visualImageMatch[1], generationId=visualImageMatch[2];
      const project=await env.DB.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").bind(projectId,user.id).first();
      if(!project)return json({ok:false,error:"Project not found."},404);
      const row=await env.DB.prepare("SELECT output_json FROM generations WHERE id=? AND project_id=? AND user_id=? AND stage='visuals' AND status='completed'").bind(generationId,projectId,user.id).first();
      if(!row)return json({ok:false,error:"Visual not found."},404);
      const meta=JSON.parse(row.output_json), object=await env.MEDIA.get(meta.object_key);
      if(!object)return json({ok:false,error:"Image file is missing from storage."},404);
      return new Response(object.body,{headers:{"content-type":meta.mime_type||"image/jpeg","content-length":String(meta.bytes),"cache-control":"private, no-store"}});
    }

    const visualsMatch = path.match(/^\/api\/projects\/([a-f0-9-]+)\/visuals$/i);
    if (visualsMatch && (method === "GET" || method === "POST")) {
      const projectId=visualsMatch[1];
      const project=await env.DB.prepare("SELECT * FROM projects WHERE id=? AND user_id=?").bind(projectId,user.id).first();
      if(!project)return json({ok:false,error:"Project not found."},404);
      if(method==="GET"){
        const rows=await env.DB.prepare("SELECT id,output_json,created_at FROM generations WHERE project_id=? AND user_id=? AND stage='visuals' AND status='completed' ORDER BY created_at DESC").bind(projectId,user.id).all();
        const latest=new Map();
        for(const row of (rows.results||[])){const meta=JSON.parse(row.output_json);if(!latest.has(meta.scene_number))latest.set(meta.scene_number,{generation_id:row.id,...meta,created_at:row.created_at});}
        return json({ok:true,visuals:[...latest.values()]});
      }
      if(!env.AI||typeof env.AI.run!=="function")return json({ok:false,error:"Cloudflare Workers AI binding AI is missing."},503);
      const body=await request.json().catch(()=>null);
      const sceneNumber=Number(body?.scene_number);
      if(!Number.isInteger(sceneNumber)||sceneNumber<1||sceneNumber>20)return json({ok:false,error:"Invalid scene number."},400);
      const scriptRow=await env.DB.prepare("SELECT output_json FROM generations WHERE project_id=? AND user_id=? AND stage='script' AND status='completed' ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id).first();
      if(!scriptRow)return json({ok:false,error:"Generate a script before creating visuals."},409);
      const script=JSON.parse(scriptRow.output_json), scene=(script.scenes||[]).find(item=>Number(item.scene)===sceneNumber);
      if(!scene)return json({ok:false,error:"Scene not found in the saved script."},404);
      const scenes=script.scenes||[];
      const sceneIndex=scenes.findIndex(item=>Number(item.scene)===sceneNumber);
      const previousScene=sceneIndex>0?scenes[sceneIndex-1]:null;
      const nextScene=sceneIndex<scenes.length-1?scenes[sceneIndex+1]:null;
      const visualPrompt=String(scene.visual_prompt||"").trim();
      if(!visualPrompt)return json({ok:false,error:"This scene has no visual prompt."},422);
      const clean=(value,max=260)=>String(value||"").replace(/\\s+/g," ").trim().slice(0,max);
      const animeMode=String(project.style||"").toLowerCase()==="anime";
      const continuation=project.continuity_json?JSON.parse(project.continuity_json):null;
      const characterBible=clean(script.character_bible||continuation?.character_bible,680);
       const sceneText=(String(scene.voiceover||"")+" "+String(scene.visual_prompt||"")).toLowerCase();
       const sceneCharacters=(Array.isArray(script.characters)?script.characters:[]).filter(c=>c&&typeof c==="object"&&c.name&&sceneText.includes(String(c.name).toLowerCase()));
       const sceneCharacterLock=sceneCharacters.map(c=>"CHARACTER "+clean(c.name,70)+": "+clean(c.visual_identity,240)+". Outfit: "+clean(c.signature_outfit,130)+". Features: "+clean(c.distinctive_features,100)+".").join(" ");
      const shotDirections=[
        "ESTABLISHING WIDE SHOT: reveal the location and scale; subject small within a richly detailed environment.",
        "MEDIUM ACTION SHOT: bring the main subject closer; capture a decisive physical action with a clear focal point.",
        "INTIMATE CLOSE-UP: emphasize a meaningful expression, object or tactile detail; shallow depth of field.",
        "LOW-ANGLE DYNAMIC SHOT: give the key subject presence; use strong foreground depth and directional movement.",
        "OVER-THE-SHOULDER OR POV SHOT: place the viewer inside the moment; reveal what the subject is seeing.",
        "ATMOSPHERIC WIDE SHOT: show consequences or a change in the environment; use layered foreground, middle ground and background.",
        "EMOTIONAL FINAL SHOT: create a memorable visual payoff that resolves this scene without adding unrelated objects."
      ];
      const shotDirection=shotDirections[(sceneIndex>=0?sceneIndex:0)%shotDirections.length];
      const prompt=[
        animeMode
          ? "Premium Japanese 2D anime film frame, hand-drawn look, expressive characters, clean linework, cinematic cel shading, richly painted background, atmospheric lighting, consistent character design, vertical 9:16. Not photorealistic or 3D."
          : "High-end cinematic photorealistic film still, believable natural anatomy, physically plausible environment, rich production design, motivated dramatic lighting, vertical 9:16.",
        "STORY: "+clean(project.topic,120)+". TITLE: "+clean(script.title,60)+".",
        characterBible
          ? "CHARACTER IDENTITY LOCK — use this character bible as the source of truth in EVERY episode and scene; do not redesign or reinterpret established characters: "+characterBible+". Preserve each named character's face shape, eye design, hair color and cut, age appearance, body proportions, signature clothing and accessories. Keep the same identity even when pose, expression, camera angle or lighting changes. If a character is not in this scene, do not add them."
          : "",
        animeMode&&continuation?.previous_ending_visual_prompt
          ? "PREVIOUS EPISODE VISUAL REFERENCE CONTEXT: "+clean(continuation.previous_ending_visual_prompt,220)+". Keep the same anime world, linework, palette and character design."
          : "",
        "INDIVIDUAL CHARACTER PROFILE LOCK — do not merge or swap designs: "+clean(sceneCharacterLock,650),
        "EXACT MOMENT TO ILLUSTRATE: "+clean(scene.voiceover,240),
        "DIRECTOR'S VISUAL BRIEF: "+clean(visualPrompt,480),
        "SHOT DESIGN: "+shotDirection,
        "COMPOSITION: One instantly readable focal subject. Strong foreground, middle-ground and background separation. Intentional negative space. Subject placement and silhouette must read clearly on a phone screen. Show the described action at its most visually informative instant.",
        "CAMERA AND LIGHT: Use a deliberate cinematic camera distance and angle, natural perspective, controlled depth of field, motivated key light, subtle rim light where appropriate, and a coherent color grade. Avoid flat centered passport-like framing.",
        animeMode
          ? "Maintain the same anime character identity, face shape, eye design, hairstyle, colors and outfit. Keep linework, cel shading and background painting consistent. Do not invent alternate costumes, change hair or eye colors, age the character, or replace established characters with lookalikes."
          : "Maintain recurring character identity, age appearance, wardrobe, era, location logic, lens language and color grade. Keep anatomy, hands, objects and architecture plausible.",
        previousScene?"PREVIOUS BEAT (continuity only): "+clean(previousScene.voiceover,90)+". Advance the story; do not repeat its action, pose or composition.":"OPENING BEAT: establish the story world with a strong visual question.",
        continuation&&sceneIndex===0?"SERIES CONTINUATION: Start from the previous episode's exact ending state. Previous action: "+clean(continuation.ending_state||continuation.previous_ending_voiceover,180)+". Previous shot: "+clean(continuation.previous_ending_visual_prompt,220)+". Preserve identity and world continuity.":"",
        nextScene?"NEXT BEAT (context only): "+clean(nextScene.voiceover,90)+". Foreshadow subtly without depicting a later event.":"FINAL BEAT: deliver a clear visual payoff that supports the narration.",
        "STRICT: one location, one camera frame, one primary action and one instant in time. Do not depict events absent from the narration. No collage, montage, grid, split screen, panels, poster, infographic, UI, text, captions, subtitles, logos, borders or watermark. Avoid generic stock-photo posing, repeated compositions, extra limbs, malformed hands, duplicate subjects and visual clutter."
      ].filter(Boolean).join(" ").slice(0,1700);
      // Keep every Workers AI prompt below the provider's 2,048-character limit,
      // including the extra continuity instructions used by image-to-image.
      const continuityPrompt=(prompt+" Use the reference image to preserve the exact character identity, face, hairstyle, clothing, art direction and color palette. Change pose, camera framing and background action for this scene; do not repeat the previous composition.").slice(0,2048);
      let referenceObjectKey=null,referenceSource=null;
      // Prefer one stable series character-reference frame across all scenes and episodes.
      if(continuation?.character_reference_object_key||continuation?.reference_image_object_key){
        referenceObjectKey=continuation.character_reference_object_key||continuation.reference_image_object_key;
        referenceSource=continuation.character_reference_object_key?"series_character_reference":"previous_episode_ending";
      }
      if(!referenceObjectKey){
        const anchorRow=await env.DB.prepare("SELECT output_json FROM generations WHERE project_id=? AND user_id=? AND stage='visuals' AND status='completed' AND json_extract(output_json,'$.scene_number')=1 ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id).first();
        if(anchorRow){try{const anchorMeta=JSON.parse(anchorRow.output_json||"{}");referenceObjectKey=anchorMeta.character_reference_object_key||anchorMeta.object_key||null;if(referenceObjectKey)referenceSource="project_character_reference";}catch{}}
      }
      // Older projects may not have a scene-one anchor yet; use the nearest earlier scene.
      if(!referenceObjectKey&&sceneIndex>0){
        for(let index=sceneIndex-1;index>=0;index--){
          const priorSceneNumber=Number(scenes[index].scene);
          const priorRow=await env.DB.prepare("SELECT output_json FROM generations WHERE project_id=? AND user_id=? AND stage='visuals' AND status='completed' AND json_extract(output_json,'$.scene_number')=? ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id,priorSceneNumber).first();
          if(priorRow){try{const priorMeta=JSON.parse(priorRow.output_json||"{}");if(priorMeta.object_key){referenceObjectKey=priorMeta.object_key;referenceSource="previous_scene_"+priorSceneNumber;break;}}catch{}}
        }
      }
      // For a scene focused on one named character, prefer that character's own R2 reference portrait.
      let selectedCharacterReferenceId=null;
      if(sceneCharacters.length===1&&sceneCharacters[0].character_reference_object_key){
        referenceObjectKey=sceneCharacters[0].character_reference_object_key;
        referenceSource="individual_character_reference";
        selectedCharacterReferenceId=sceneCharacters[0].id;
      }
      const generationId=crypto.randomUUID();
      const preferredModel=referenceObjectKey?"@cf/runwayml/stable-diffusion-v1-5-img2img":"@cf/black-forest-labs/flux-1-schnell";
      await env.DB.prepare("INSERT INTO generations (id,project_id,user_id,stage,status,input_json) VALUES (?,?,?,'visuals','processing',?)").bind(generationId,projectId,user.id,JSON.stringify({model:preferredModel,scene_number:sceneNumber,prompt,reference_object_key:referenceObjectKey,reference_source:referenceSource})).run();
      try{
        let bytes=null,actualModel=preferredModel,continuityMode=referenceObjectKey?"image-to-image":"text-to-image",continuityFallback=null,referenceStrength=null;
        const decodeBase64=value=>{const binary=atob(value),output=new Uint8Array(binary.length);for(let index=0;index<binary.length;index++)output[index]=binary.charCodeAt(index);return output;};
        const readImageResult=async result=>{
          if(typeof result==="string")return decodeBase64(result);
          if(result?.image&&typeof result.image==="string")return decodeBase64(result.image);
          if(result?.image instanceof Uint8Array)return result.image;
          if(result instanceof ArrayBuffer)return new Uint8Array(result);
          if(ArrayBuffer.isView(result))return new Uint8Array(result.buffer,result.byteOffset,result.byteLength);
          if(typeof ReadableStream!=="undefined"&&result instanceof ReadableStream)return new Uint8Array(await new Response(result).arrayBuffer());
          throw new Error("Image model returned an unsupported image response.");
        };
        if(referenceObjectKey){
          try{
            const referenceObject=await env.MEDIA.get(referenceObjectKey);
            if(!referenceObject)throw new Error("The saved continuity reference image is missing from R2.");
            const referenceBytes=new Uint8Array(await referenceObject.arrayBuffer());
            if(!referenceBytes.byteLength||referenceBytes.byteLength>5*1024*1024)throw new Error("The continuity reference image is empty or larger than 5 MB.");
            const strength=["series_character_reference","project_character_reference"].includes(referenceSource)?0.44:referenceSource==="previous_episode_ending"?0.42:0.50;
            referenceStrength=strength;
            const result=await env.AI.run("@cf/runwayml/stable-diffusion-v1-5-img2img",{
              prompt:continuityPrompt,
              image:Array.from(referenceBytes),strength,guidance:7.5,num_steps:20,width:768,height:1344,
              negative_prompt:"different character, changed face, changed hairstyle, changed outfit, inconsistent art style, duplicate people, collage, split screen, text, watermark"
            });
            bytes=await readImageResult(result);
          }catch(referenceError){
            continuityFallback=String(referenceError.message||referenceError).slice(0,240);
            const fallbackResult=await env.AI.run("@cf/black-forest-labs/flux-1-schnell",{prompt,steps:4});
            bytes=await readImageResult(fallbackResult);actualModel="@cf/black-forest-labs/flux-1-schnell";continuityMode="text-fallback";
          }
        }else{const result=await env.AI.run("@cf/black-forest-labs/flux-1-schnell",{prompt,steps:4});bytes=await readImageResult(result);}
        if(!bytes?.byteLength)throw new Error("Image model returned an empty image.");
        const objectKey="users/"+user.id+"/projects/"+projectId+"/visuals/"+generationId+".png";
        await env.MEDIA.put(objectKey,bytes,{httpMetadata:{contentType:"image/png",cacheControl:"private, max-age=3600"},customMetadata:{userId:user.id,projectId,generationId,sceneNumber:String(sceneNumber),continuityMode}});
        // Scene one becomes the persistent character-reference frame. Reuse it instead of
        // generating an extra portrait, keeping image-generation cost and storage low.
        const characterReferenceObjectKey=referenceObjectKey||objectKey;
        const output={object_key:objectKey,mime_type:"image/png",bytes:bytes.byteLength,provider:"cloudflare-workers-ai",model:actualModel,scene_number:sceneNumber,prompt,continuity_mode:continuityMode,reference_source:referenceSource,reference_object_key:referenceObjectKey,reference_strength:referenceStrength,character_reference_object_key:characterReferenceObjectKey,character_reference_source:referenceSource==="individual_character_reference"?"individual_character_reference":referenceObjectKey?"reused_existing_anchor":"scene_1_anchor",character_reference_id:selectedCharacterReferenceId,continuity_fallback_error:continuityFallback};
        await env.DB.prepare("UPDATE generations SET status='completed',output_json=?,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(JSON.stringify(output),generationId,user.id).run();
        return json({ok:true,generation_id:generationId,visual:{generation_id:generationId,...output}},201);      }catch(error){
        await env.DB.prepare("UPDATE generations SET status='failed',error_message=?,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(String(error.message||error).slice(0,500),generationId,user.id).run();
        const message=String(error.message||"Visual generation failed.");
        return json({ok:false,error:message},/limit|quota|billing|exceeded/i.test(message)?429:502);
      }
    }

    const subtitlesMatch = path.match(/^\/api\/projects\/([a-f0-9-]+)\/subtitles$/i);
    if (subtitlesMatch && (method === "GET" || method === "POST")) {
      const projectId = subtitlesMatch[1];
      const project = await env.DB.prepare("SELECT id, duration_seconds FROM projects WHERE id = ? AND user_id = ?").bind(projectId, user.id).first();
      if (!project) return json({ ok: false, error: "Project not found." }, 404);
      if (method === "GET") {
        const saved = await env.DB.prepare("SELECT id, output_json, created_at FROM generations WHERE project_id = ? AND user_id = ? AND stage = 'subtitles' AND status = 'completed' ORDER BY created_at DESC LIMIT 1").bind(projectId, user.id).first();
        return json({ ok: true, subtitles: saved ? JSON.parse(saved.output_json) : null, generation_id: saved?.id || null });
      }
      if (!env.AI || typeof env.AI.run !== "function") return json({ ok: false, error: "Speech recognition is unavailable. Check the Workers AI binding." }, 503);
      const scriptRow = await env.DB.prepare("SELECT id, output_json FROM generations WHERE project_id = ? AND user_id = ? AND stage = 'script' AND status = 'completed' ORDER BY created_at DESC LIMIT 1").bind(projectId, user.id).first();
      if (!scriptRow) return json({ ok: false, error: "Generate a script before creating subtitles." }, 409);
      let sourceScript = {};
      try { sourceScript = JSON.parse(scriptRow.output_json || "{}"); } catch { sourceScript = {}; }
      const sourceNarration = String(sourceScript.narration || (sourceScript.scenes || []).map(scene => scene.voiceover || "").join(" ")).trim();
      const voiceRow = await env.DB.prepare("SELECT output_json FROM generations WHERE project_id = ? AND user_id = ? AND stage = 'voice' AND status = 'completed' AND json_extract(input_json, '$.script_generation_id') = ? ORDER BY created_at DESC LIMIT 1").bind(projectId, user.id, scriptRow.id).first();
      if (!voiceRow) return json({ ok: false, error: "Generate the voice-over first. Subtitles are now synchronized from the actual audio." }, 409);
      let voiceMeta;
      try { voiceMeta = JSON.parse(voiceRow.output_json || "{}"); } catch { voiceMeta = {}; }
      if (!voiceMeta.object_key) return json({ ok: false, error: "The saved voice-over file could not be located. Regenerate the voice-over and try again." }, 404);
      const audioObject = await env.MEDIA.get(voiceMeta.object_key);
      if (!audioObject) return json({ ok: false, error: "The voice-over audio is missing from storage. Regenerate it and try again." }, 404);
      const audioBytes = new Uint8Array(await audioObject.arrayBuffer());
      if (!audioBytes.byteLength) return json({ ok: false, error: "The voice-over audio is empty. Regenerate it and try again." }, 422);
      if (audioBytes.byteLength > 5 * 1024 * 1024) return json({ ok: false, error: "This voice-over is larger than the current 5 MB transcription limit." }, 413);
      const generationId = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO generations (id, project_id, user_id, stage, status, input_json) VALUES (?, ?, ?, 'subtitles', 'processing', ?)").bind(generationId, projectId, user.id, JSON.stringify({ source: "saved voice-over audio", timing: "audio-aligned", model: "@cf/openai/whisper" })).run();
      try {
        const rawResult = await env.AI.run("@cf/openai/whisper", { audio: Array.from(audioBytes) });
        const transcription = rawResult?.response || rawResult || {};
        const rawWords = Array.isArray(transcription.words) ? transcription.words : (Array.isArray(transcription.segments) ? transcription.segments.flatMap(segment => Array.isArray(segment.words) ? segment.words : []) : []);
        const words = rawWords.map(item => ({ word: String(item.word || "").trim(), start: Number(item.start), end: Number(item.end) }))
          .filter(item => item.word && Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start && item.start >= 0);
        let cues = [];
        if (words.length) {
          // Build compact, phrase-level captions from Whisper word timestamps.
          // Keep real word timing; never estimate per-word timing from a sentence.
          let group = [];
          const flush = () => {
            if (!group.length) return;
            const start = Math.max(0, group[0].start - 0.04);
            const end = Math.max(start + 0.2, group[group.length - 1].end + 0.07);
            const text = group.map(item => item.word).join(" ")
              .replace(/\\s+([,.;!?])/g, "$1")
              .replace(/\\s+([’'])/g, "$1")
              .replace(/\\s+(:)/g, "$1")
              .trim();
            cues.push({ index: cues.length + 1, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)), text });
            group = [];
          };
          for (const item of words) {
            const candidate = group.concat(item);
            const candidateText = candidate.map(word => word.word).join(" ").replace(/\s+([,.;!?])/g, "$1");
            const gap = group.length ? Math.max(0, item.start - group[group.length - 1].end) : 0;
            const phraseEnds = /[.!?]["')\]]?$/.test(item.word);
            // Compact phrase cards are easier to read on a phone than long transcript strips.
            // Preserve Whisper's real word timestamps instead of estimating cue timing.
            const tooLong = candidate.length > 4 || candidateText.length > 30;
            const tooSlow = group.length && item.end - group[0].start > 1.9;
            if (group.length && (tooLong || tooSlow || gap > 0.32 || (phraseEnds && candidate.length >= 2))) flush();
            group.push(item);
            if (phraseEnds && group.length >= 2) flush();
          }
          flush();
        } else if (typeof transcription.vtt === "string") {
          const parseVttTime = value => {
            const match = value.trim().match(/(?:(\d{2}):)?(\d{2}):(\d{2})[.,](\d{3})/);
            return match ? (Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000) : NaN;
          };
          const lines = transcription.vtt.replace(/^WEBVTT[^\n]*\n/i, "").split(/\n\s*\n/);
          for (const block of lines) {
            const rows = block.split(/\n/).map(line => line.trim()).filter(Boolean);
            const timingIndex = rows.findIndex(line => line.includes("-->"));
            if (timingIndex < 0) continue;
            const times = rows[timingIndex].split("-->");
            const cueStart = parseVttTime(times[0]), cueEnd = parseVttTime(times[1] || "");
            const caption = rows.slice(timingIndex + 1).join(" ").trim();
            if (caption && Number.isFinite(cueStart) && Number.isFinite(cueEnd) && cueEnd > cueStart) cues.push({ index: cues.length + 1, start: Number(cueStart.toFixed(3)), end: Number(cueEnd.toFixed(3)), text: caption });
          }
        }
        if (!cues.length) throw new Error("Speech recognition returned no usable timestamps. Please regenerate the voice-over and retry subtitles.");
        const whisperTranscript = String(transcription.text || cues.map(cue => cue.text).join(" ")).trim();
        const normalizeForMatch = value => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(token => token.length > 1);
        const expectedTokens = normalizeForMatch(sourceNarration);
        const heardTokens = normalizeForMatch(whisperTranscript);
        const heardSet = new Set(heardTokens);
        const matchedTokens = expectedTokens.filter(token => heardSet.has(token)).length;
        const matchScore = expectedTokens.length ? matchedTokens / expectedTokens.length : 1;
        const whisperDuration = Number(Math.max(...cues.map(cue => cue.end)).toFixed(3));
        let subtitleSource = "whisper-audio";
        let timingMode = "audio-aligned";
        // Bad ASR can produce plausible timestamps but completely wrong words.
        // Prefer the approved script over visibly corrupted captions.
        if (sourceNarration && matchScore < 0.72) {
          const sentences = sourceNarration.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map(value => value.trim()).filter(Boolean) || [sourceNarration];
          // Keep fallback captions compact and phone-readable instead of showing a whole
          // narration sentence at once. Preserve punctuation on the final phrase.
          const phrases = [];
          for (const sentence of sentences) {
            const tokens = sentence.match(/\\S+/g) || [];
            let group = [];
            for (const token of tokens) {
              const candidate = group.concat(token);
              const candidateText = candidate.join(" ");
              if (group.length && (candidate.length > 4 || candidateText.length > 30)) {
                phrases.push(group.join(" "));
                group = [token];
              } else {
                group = candidate;
              }
            }
            if (group.length) phrases.push(group.join(" "));
          }
          const totalWords = phrases.reduce((sum, phrase) => sum + normalizeForMatch(phrase).length, 0) || 1;
          let elapsed = 0;
          cues = phrases.map((phrase, index) => {
            const wordsInPhrase = normalizeForMatch(phrase).length;
            const start = elapsed;
            elapsed += whisperDuration * wordsInPhrase / totalWords;
            return { index: index + 1, start: Number(start.toFixed(3)), end: Number(elapsed.toFixed(3)), text: phrase };
          }).filter(cue => cue.end > cue.start);
          if (cues.length) cues[cues.length - 1].end = whisperDuration;
          subtitleSource = "script-fallback-low-whisper-confidence";
          timingMode = "estimated-from-script-and-audio-duration";
        }
        const duration = Number(Math.max(...cues.map(cue => cue.end)).toFixed(3));
        const subtitleData = { format: "webvtt", timing: timingMode, source: subtitleSource, model: "@cf/openai/whisper", duration_seconds: duration, word_count: words.length || Number(transcription.word_count) || 0, transcript: whisperTranscript.slice(0, 12000), script_match_score: Number(matchScore.toFixed(3)), quality_check: matchScore < 0.72 ? "low-whisper-match-script-fallback-used" : "whisper-transcript-accepted", cues };
        await env.DB.prepare("UPDATE generations SET status='completed', input_json=?, output_json=?, updated_at=unixepoch() WHERE id=? AND user_id=?").bind(JSON.stringify({ source: "saved voice-over audio", timing: timingMode, model: "@cf/openai/whisper", audio_bytes: audioBytes.byteLength, script_match_score: Number(matchScore.toFixed(3)), subtitle_source: subtitleSource }), JSON.stringify(subtitleData), generationId, user.id).run();
        return json({ ok: true, subtitles: subtitleData, generation_id: generationId }, 201);
      } catch (error) {
        await env.DB.prepare("UPDATE generations SET status='failed', error_message=?, updated_at=unixepoch() WHERE id=? AND user_id=?").bind(String(error.message || error).slice(0, 500), generationId, user.id).run();
        const message = String(error.message || "Speech recognition failed.");
        return json({ ok: false, error: message }, /limit|quota|billing|credit|exceeded/i.test(message) ? 429 : 502);
      }
    }

    const existingScriptMatch = path.match(/^\/api\/projects\/([a-f0-9-]+)\/script$/i);
    if(existingScriptMatch&&method==="GET"){
      const projectId=existingScriptMatch[1];
      const project=await env.DB.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").bind(projectId,user.id).first();
      if(!project)return json({ok:false,error:"Project not found."},404);
      const result=await env.DB.prepare("SELECT id,status,output_json,error_message,created_at FROM generations WHERE project_id=? AND user_id=? AND stage='script' ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id).first();
      return json({ok:true,script:result?.status==="completed"&&result.output_json?JSON.parse(result.output_json):null,generation_id:result?.id||null,status:result?.status||"empty",error:result?.error_message||null,created_at:result?.created_at||null});
    }

    const continueMatch = path.match(/^\/api\/projects\/([a-f0-9-]+)\/continue$/i);
    if (continueMatch && method === "POST") {
      const parentId = continueMatch[1];
      const parent = await env.DB.prepare("SELECT * FROM projects WHERE id=? AND user_id=?").bind(parentId,user.id).first();
      if (!parent) return json({ok:false,error:"Source project not found."},404);
      const scriptRow = await env.DB.prepare("SELECT id,output_json FROM generations WHERE project_id=? AND user_id=? AND stage='script' AND status='completed' ORDER BY created_at DESC LIMIT 1").bind(parentId,user.id).first();
      if (!scriptRow) return json({ok:false,error:"Generate the source episode script before continuing it."},409);
      const previousScript = JSON.parse(scriptRow.output_json);
      const previousScenes = Array.isArray(previousScript.scenes)?previousScript.scenes:[];
      const lastScene = previousScenes[previousScenes.length-1] || {};
      const visualRows = await env.DB.prepare("SELECT output_json FROM generations WHERE project_id=? AND user_id=? AND stage='visuals' AND status='completed' ORDER BY created_at DESC LIMIT 30").bind(parentId,user.id).all();
      let endingVisual = null, endingVisualSceneNumber = null, characterReferenceObjectKey = null;
      for (const row of (visualRows.results||[])) {
        try {
          const meta=JSON.parse(row.output_json||"{}");
          if(!characterReferenceObjectKey&&meta.character_reference_object_key)characterReferenceObjectKey=meta.character_reference_object_key;
          if(!characterReferenceObjectKey&&Number(meta.scene_number)===1&&meta.object_key)characterReferenceObjectKey=meta.object_key;
          if(!endingVisual&&meta.object_key){endingVisual=meta;endingVisualSceneNumber=Number(meta.scene_number)||null;}
          if(Number(meta.scene_number)===Number(lastScene.scene)&&meta.object_key){endingVisual=meta;endingVisualSceneNumber=Number(meta.scene_number)||null;}
        } catch {}
      }
      const episodeNumber = Math.max(1,Number(parent.episode_number)||1)+1;
      const rootProjectId = parent.parent_project_id || parent.id;
      const rootTitle = String(parent.title||"Untitled series").replace(/\s+—\s+Part\s+\d+$/i,"");
      const continuity = {
        root_project_id:rootProjectId, episode_number:episodeNumber, previous_project_id:parentId,
        previous_title:previousScript.title||parent.title,
        previous_narration:String(previousScript.narration||"").slice(-2600),
        previous_ending_voiceover:String(lastScene.voiceover||"").slice(0,900),
        previous_ending_visual_prompt:String(lastScene.visual_prompt||endingVisual?.prompt||"").slice(0,1000),
        series_summary:String(previousScript.series_summary||previousScript.narration||"").slice(-2600),
        character_bible:String(previousScript.character_bible||previousScenes.map(scene=>String(scene.visual_prompt||"")).join(" | ")).slice(0,1400),
        ending_state:String(previousScript.ending_state||lastScene.voiceover||"").slice(0,1000),
        reference_image_object_key:endingVisual?.object_key||null,
        character_reference_object_key:characterReferenceObjectKey||endingVisual?.object_key||null,
        reference_scene_number:endingVisualSceneNumber,
        visual_reference_available:Boolean(characterReferenceObjectKey||endingVisual?.object_key),
        character_reference_available:Boolean(characterReferenceObjectKey||endingVisual?.object_key), style:parent.style, language:"en"
      };
      const id=crypto.randomUUID();
      const title=rootTitle+" — Part "+episodeNumber;
      await env.DB.prepare("INSERT INTO projects (id,user_id,title,topic,status,aspect_ratio,language,duration_seconds,style,parent_project_id,episode_number,continuity_json) VALUES (?,?,?,?,'draft','9:16','en',?,?,?,?,?)")
        .bind(id,user.id,title,parent.topic||rootTitle,parent.duration_seconds||45,parent.style||"storytelling",parentId,episodeNumber,JSON.stringify(continuity)).run();
      return json({ok:true,project:{id,title,topic:parent.topic,status:"draft",aspect_ratio:"9:16",language:"en",duration_seconds:parent.duration_seconds||45,style:parent.style,parent_project_id:parentId,episode_number:episodeNumber},continuation:{episode_number:episodeNumber,visual_reference_available:Boolean(endingVisual?.object_key),reference_scene_number:endingVisualSceneNumber}},201);
    }
    if (path === "/api/projects" && method === "GET") {
      const result = await env.DB.prepare(
        "SELECT id, title, topic, status, aspect_ratio, language, duration_seconds, style, parent_project_id, episode_number, created_at, updated_at FROM projects WHERE user_id = ? ORDER BY created_at DESC LIMIT 100"
      ).bind(user.id).all();
      return json({ ok: true, projects: result.results || [] });
    }
    if (path === "/api/projects" && method === "POST") {
      const body = await request.json().catch(() => null);
      const topic = String(body?.topic || "").trim();
      if (topic.length < 5 || topic.length > 5000) return json({ ok: false, error: "Topic must be between 5 and 5000 characters." }, 400);
      const language = "en";
      const duration = [30, 45, 60].includes(Number(body?.duration)) ? Number(body.duration) : 45;
      const styles = ["storytelling", "anime", "educational", "toplist", "motivation", "news"];
      const style = styles.includes(body?.style) ? body.style : "storytelling";
      const id = crypto.randomUUID();
      const title = topic.length > 72 ? topic.slice(0, 69) + "..." : topic;
      await env.DB.prepare(
        "INSERT INTO projects (id, user_id, title, topic, status, aspect_ratio, language, duration_seconds, style) VALUES (?, ?, ?, ?, 'draft', '9:16', ?, ?, ?)"
      ).bind(id, user.id, title, topic, language, duration, style).run();
      return json({ ok: true, project: { id, title, topic, status: "draft", aspect_ratio: "9:16", language, duration, style } }, 201);
    }
    return json({ ok: false, error: "Not found" }, 404);
  }

  return json({ ok: false, error: "Not found" }, 404);
}

async function runScheduledMaintenance(env, scheduledTime) {
  const now = Math.floor(Date.now() / 1000);
  const staleBefore = now - 30 * 60;

  // Recover jobs abandoned by an isolate termination or provider timeout.
  // They become visibly failed so the user can safely retry them.
  const staleJobs = await env.DB.prepare(
    "UPDATE generations SET status='failed', error_message=COALESCE(error_message, 'Job timed out before completion. Please retry this step.'), updated_at=? WHERE status='processing' AND updated_at < ?"
  ).bind(now, staleBefore).run();

  // Remove expired session hashes; active sessions are unaffected.
  const expiredSessions = await env.DB.prepare(
    "DELETE FROM user_sessions WHERE expires_at <= ?"
  ).bind(now).run();

  console.log(JSON.stringify({
    event: "scheduled_maintenance_completed",
    scheduled_at: new Date(scheduledTime || now * 1000).toISOString(),
    stale_jobs_recovered: Number(staleJobs.meta?.changes || 0),
    expired_sessions_removed: Number(expiredSessions.meta?.changes || 0)
  }));
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages) { if (message.body?.type === "generate_voice") await processVoiceQueueMessage(message, env); else await processScriptQueueMessage(message, env); }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledMaintenance(env, controller.scheduledTime).catch(error => {
      console.error(JSON.stringify({
        event: "scheduled_maintenance_failed",
        error: String(error?.message || error).slice(0, 500)
      }));
    }));
  },
  async fetch(request, env) {
    const origin = request.headers.get("origin");
    const allowedOrigin = env.APP_ORIGIN || "*";
    const headers = {
      "access-control-allow-origin": allowedOrigin === "*" ? "*" : (origin === allowedOrigin ? origin : allowedOrigin),
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, authorization, x-video-title, x-video-duration, x-video-quality",
      "access-control-max-age": "86400",
      "vary": "Origin",
      "x-content-type-options": "nosniff"
    };
    try {
      const response = await handle(request, env);
      const finalHeaders = new Headers(response.headers);
      for (const [key, value] of Object.entries(headers)) finalHeaders.set(key, value);
      return new Response(response.body, { status: response.status, headers: finalHeaders });
    } catch (error) {
      console.error(JSON.stringify({
        event: "request_failed",
        path: new URL(request.url).pathname,
        method: request.method,
        error: String(error?.message || error).slice(0, 500)
      }));
      return json({ ok: false, error: "Internal server error", detail: env.APP_ENV === "development" ? String(error?.stack || error) : undefined }, 500, headers);
    }
  }
};
