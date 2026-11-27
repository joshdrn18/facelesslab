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


const DEFAULT_AI_DAILY_REQUEST_LIMIT = 40;
const FACELESSLAB_DAILY_AI_REQUEST_LIMIT = 80;
const FACELESSLAB_DAILY_TTS_CHARACTER_LIMIT = 10000;
const FACELESSLAB_ACCOUNT_NEURON_SOFT_STOP = 8000;
async function readAIUsageSettings(env) {
  await env.DB.prepare("INSERT OR IGNORE INTO ai_usage_settings (id,daily_request_limit,warning_percent) VALUES ('global',?,80)")
    .bind(DEFAULT_AI_DAILY_REQUEST_LIMIT).run();
  const row = await env.DB.prepare("SELECT daily_request_limit,warning_percent,updated_at FROM ai_usage_settings WHERE id='global'").first();
  return {
    daily_request_limit: Math.max(0, Number(row?.daily_request_limit ?? DEFAULT_AI_DAILY_REQUEST_LIMIT)),
    warning_percent: Math.min(95, Math.max(50, Number(row?.warning_percent ?? 80))),
    updated_at: Number(row?.updated_at || 0)
  };
}
function estimateAIOutputBytes(result) {
  if (result instanceof ArrayBuffer) return result.byteLength;
  if (ArrayBuffer.isView(result)) return result.byteLength;
  if (typeof result === "string") return Math.floor(result.length * 0.75);
  if (!result || typeof result !== "object") return 0;
  for (const value of [result.audio, result.image, result.data, result.response]) {
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (typeof value === "string") return Math.floor(value.length * 0.75);
  }
  return 0;
}
async function fetchCloudflareAiAnalytics(env, startDate, endDate) {
  if (!env.CF_API_TOKEN) return { success:false, error:"CF_API_TOKEN is not configured." };
  const query =
    "query { viewer { accounts(filter:{accountTag:\"7fba808c5a694f2755dc45ab94cee505\"}) { " +
    "aiInferenceAdaptiveGroups(limit:1000,filter:{date_geq:\"" + startDate + "\",date_leq:\"" + endDate + "\"},orderBy:[datetime_ASC]) { " +
    "count sum { totalNeurons totalAudioSeconds totalInferenceSteps totalInferenceTimeMs totalInputTokens totalOutputTokens totalProcessedPixels totalRequestBytesIn totalRequestBytesOut } " +
    "dimensions { date datetime modelId neurons requestSource requestBytesIn requestBytesOut inferenceTimeMs costMetricName1 costMetricValue1 costMetricName2 costMetricValue2 } " +
    "} } } }";
  try {
    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method:"POST",
      headers:{authorization:"Bearer "+env.CF_API_TOKEN,"content-type":"application/json",accept:"application/json"},
      body:JSON.stringify({query}),
      signal:AbortSignal.timeout(12000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || (payload.errors || []).length) {
      const detail=(payload.errors || []).map(item=>String(item.message||"GraphQL error")).join("; ");
      return {success:false,http_status:response.status,error:(detail||"Cloudflare Analytics GraphQL request failed").slice(0,260)};
    }
    const account=payload.data?.viewer?.accounts?.[0];
    if (!account) return {success:false,http_status:response.status,error:"Cloudflare Analytics returned no account. Check Account Analytics:Read permission."};
    const groups=Array.isArray(account.aiInferenceAdaptiveGroups)?account.aiInferenceAdaptiveGroups:[];
    const byDay={},byModel={};
    let totalNeurons=0,totalRequests=0;
    for (const group of groups) {
      const d=group.dimensions||{},sum=group.sum||{};
      const date=String(d.date||"unknown"),model=String(d.modelId||"unknown");
      const requests=Math.max(0,Number(group.count)||0),neurons=Math.max(0,Number(sum.totalNeurons)||0);
      totalRequests+=requests;totalNeurons+=neurons;
      if(!byDay[date])byDay[date]={date,requests:0,neurons:0};
      byDay[date].requests+=requests;byDay[date].neurons+=neurons;
      if(!byModel[model])byModel[model]={model,requests:0,neurons:0,inference_ms:0,audio_seconds:0,input_tokens:0,output_tokens:0,processed_pixels:0,input_bytes:0,output_bytes:0};
      const item=byModel[model];
      item.requests+=requests;item.neurons+=neurons;
      item.inference_ms+=Number(sum.totalInferenceTimeMs)||0;
      item.audio_seconds+=Number(sum.totalAudioSeconds)||0;
      item.input_tokens+=Number(sum.totalInputTokens)||0;
      item.output_tokens+=Number(sum.totalOutputTokens)||0;
      item.processed_pixels+=Number(sum.totalProcessedPixels)||0;
      item.input_bytes+=Number(sum.totalRequestBytesIn)||0;
      item.output_bytes+=Number(sum.totalRequestBytesOut)||0;
    }
    const today=new Date().toISOString().slice(0,10),todayData=byDay[today]||{date:today,requests:0,neurons:0};
    const round=(value,digits=3)=>Number(Number(value||0).toFixed(digits));
    return {
      success:true,http_status:response.status,source:"cloudflare_graphql_ai_inference",
      checked_at:new Date().toISOString(),period_from:startDate,period_to:endDate,groups:groups.length,
      today:{...todayData,neurons:round(todayData.neurons),remaining_neurons:round(Math.max(0,10000-todayData.neurons)),allowance_neurons:10000,percent_used:round(todayData.neurons/100,2)},
      total:{requests:totalRequests,neurons:round(totalNeurons)},
      by_day:Object.values(byDay).sort((a,b)=>a.date.localeCompare(b.date)).map(x=>({...x,neurons:round(x.neurons)})),
      by_model:Object.values(byModel).sort((a,b)=>b.neurons-a.neurons).map(x=>({...x,neurons:round(x.neurons),avg_neurons_per_request:x.requests?round(x.neurons/x.requests,3):0}))
    };
  } catch(error) {
    return {success:false,http_status:0,error:String(error?.message||error).slice(0,260)};
  }
}

async function runTrackedAI(env, context, model, input) {
  const settings=await readAIUsageSettings(env);
  // Resolve the role from D1 on the server; never trust a client-supplied role.
  const account=await env.DB.prepare("SELECT role FROM users WHERE id=? AND status='active'").bind(context.user_id).first();
  const isAdmin=account?.role==="admin";
  const now=Math.floor(Date.now()/1000),utcDayStart=Math.floor(now/86400)*86400;
  const utcDate=new Date(now*1000).toISOString().slice(0,10);
  const eventId=crypto.randomUUID(),stage=String(context.stage||"unknown").slice(0,40);
  const inputCharacters=Math.max(0,Number(context.input_characters||0));
  const inputBytes=Math.max(0,Number(context.input_bytes||0));
  const analytics=await fetchCloudflareAiAnalytics(env,utcDate,utcDate);
  let baselineRequests=0,baselineNeurons=0;
  if(analytics.success){
    baselineRequests=Number(analytics.today.requests||0);
    baselineNeurons=Number(analytics.today.neurons||0);
  }else{
    const [tracked,legacy,storedUsage]=await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM ai_inference_events WHERE created_at>=?").bind(utcDayStart).first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM generations g WHERE g.created_at>=? AND g.stage IN ('voice','visuals','character_reference','subtitles') AND NOT EXISTS (SELECT 1 FROM ai_inference_events e WHERE e.generation_id=g.id)").bind(utcDayStart).first(),
      env.DB.prepare("SELECT analytics_neurons FROM ai_usage_daily_counters WHERE utc_date=?").bind(utcDate).first()
    ]);
    baselineRequests=Number(tracked?.count||0)+Number(legacy?.count||0);
    baselineNeurons=Number(storedUsage?.analytics_neurons||0);
  }
  // Native Workers AI models use the account-wide Neuron allowance.
  // Aura-1 costs 1,363.64 Neurons per 1,000 input characters; estimate the
  // request before inference so the 8,000-Neuron safety stop is respected.
  const usesWorkersAiNeurons=String(model||"").startsWith("@cf/");
  const estimatedTtsNeurons=model==="@cf/deepgram/aura-1" ? inputCharacters*1.36364 : 0;
  const wouldCrossNeuronSafetyStop=baselineNeurons>=FACELESSLAB_ACCOUNT_NEURON_SOFT_STOP ||
    (estimatedTtsNeurons>0 && baselineNeurons+estimatedTtsNeurons>FACELESSLAB_ACCOUNT_NEURON_SOFT_STOP);
  if (usesWorkersAiNeurons && analytics.success && wouldCrossNeuronSafetyStop) {
    const error = new Error("FacelessLab paused this Workers AI request to protect the 8,000-Neuron daily safety budget. Current account usage: "+Math.round(baselineNeurons)+" Neurons; estimated Aura-1 request: "+Math.round(estimatedTtsNeurons)+" Neurons. Try again after the UTC reset.");
    error.code = "AI_ACCOUNT_NEURON_SOFT_STOP";
    throw error;
  }
  await env.DB.prepare("INSERT OR IGNORE INTO ai_usage_daily_counters (utc_date,analytics_requests,pending_requests,analytics_neurons) VALUES (?,?,0,?)")
    .bind(utcDate,baselineRequests,baselineNeurons).run();
  if(analytics.success){
    await env.DB.prepare(
      "UPDATE ai_usage_daily_counters SET analytics_requests=MAX(analytics_requests,?),analytics_neurons=MAX(analytics_neurons,?),updated_at=unixepoch() WHERE utc_date=?"
    ).bind(baselineRequests,baselineNeurons,utcDate).run();
  }
  // The app cap is shared by non-admin members only. Admin calls remain logged
  // and count against Cloudflare usage, but do not consume the member request cap.
  let reservedMemberRequest=false;
  if(!isAdmin){
    const reservation=await env.DB.prepare(
      "UPDATE ai_usage_daily_counters SET member_requests=member_requests+1,updated_at=unixepoch() "+
      "WHERE utc_date=? AND (?=0 OR member_requests<?)"
    ).bind(utcDate,settings.daily_request_limit,settings.daily_request_limit).run();
    if(Number(reservation.meta?.changes||0)!==1){
      const error=new Error("FacelessLab member Workers AI safety cap reached ("+settings.daily_request_limit+" non-admin model requests). Admin accounts are exempt from this app cap. Cloudflare's account-level Neuron allowance and model limits still apply.");
      error.code="AI_DAILY_LIMIT_REACHED";throw error;
    }
    reservedMemberRequest=true;
  }

  // Count every FacelessLab inference, including admin calls. This is separate
  // from Cloudflare's account-wide Neuron analytics and remains available if
  // Analytics is delayed or temporarily unavailable.
  let reservedFacelessRequest=false,reservedTtsCharacters=false;
  const appReservation=await env.DB.prepare(
    "UPDATE ai_usage_daily_counters SET faceless_requests=faceless_requests+1,updated_at=unixepoch() WHERE utc_date=? AND faceless_requests<?"
  ).bind(utcDate,FACELESSLAB_DAILY_AI_REQUEST_LIMIT).run();
  if(Number(appReservation.meta?.changes||0)!==1){
    if(reservedMemberRequest) await env.DB.prepare("UPDATE ai_usage_daily_counters SET member_requests=MAX(0,member_requests-1),updated_at=unixepoch() WHERE utc_date=?").bind(utcDate).run().catch(()=>{});
    const error=new Error("FacelessLab daily AI safety cap reached ("+FACELESSLAB_DAILY_AI_REQUEST_LIMIT+" total model calls across all accounts, including admins). Try again after the UTC daily reset.");
    error.code="AI_DAILY_APP_LIMIT_REACHED";throw error;
  }
  reservedFacelessRequest=true;

  if(stage==="voice" && inputCharacters>0){
    const ttsReservation=await env.DB.prepare(
      "UPDATE ai_usage_daily_counters SET tts_characters=tts_characters+?,updated_at=unixepoch() WHERE utc_date=? AND tts_characters+?<=?"
    ).bind(inputCharacters,utcDate,inputCharacters,FACELESSLAB_DAILY_TTS_CHARACTER_LIMIT).run();
    if(Number(ttsReservation.meta?.changes||0)!==1){
      await env.DB.prepare("UPDATE ai_usage_daily_counters SET faceless_requests=MAX(0,faceless_requests-1),updated_at=unixepoch() WHERE utc_date=?").bind(utcDate).run().catch(()=>{});
      if(reservedMemberRequest) await env.DB.prepare("UPDATE ai_usage_daily_counters SET member_requests=MAX(0,member_requests-1),updated_at=unixepoch() WHERE utc_date=?").bind(utcDate).run().catch(()=>{});
      const error=new Error("FacelessLab daily voice limit reached ("+FACELESSLAB_DAILY_TTS_CHARACTER_LIMIT+" TTS characters). Try again after the UTC daily reset.");
      error.code="AI_DAILY_TTS_LIMIT_REACHED";throw error;
    }
    reservedTtsCharacters=true;
  }

  try{
    await env.DB.prepare("INSERT INTO ai_inference_events (id,user_id,project_id,generation_id,stage,model,status,input_characters,input_bytes) VALUES (?,?,?,?,?,?,'processing',?,?)")
      .bind(eventId,context.user_id,context.project_id||null,context.generation_id||null,stage,model,inputCharacters,inputBytes).run();
  }catch(insertError){
    if(reservedTtsCharacters){
      await env.DB.prepare("UPDATE ai_usage_daily_counters SET tts_characters=MAX(0,tts_characters-?),updated_at=unixepoch() WHERE utc_date=?").bind(inputCharacters,utcDate).run().catch(()=>{});
    }
    if(reservedFacelessRequest){
      await env.DB.prepare("UPDATE ai_usage_daily_counters SET faceless_requests=MAX(0,faceless_requests-1),updated_at=unixepoch() WHERE utc_date=?").bind(utcDate).run().catch(()=>{});
    }
    if(reservedMemberRequest){
      await env.DB.prepare("UPDATE ai_usage_daily_counters SET member_requests=MAX(0,member_requests-1),updated_at=unixepoch() WHERE utc_date=?").bind(utcDate).run().catch(()=>{});
    }
    throw insertError;
  }
  const startedAt=Date.now();
  try{
    let result=await env.AI.run(model,input);
    const usage=result?.usage||result?.response?.usage||result?.usageMetadata||{};
    let outputBytes=estimateAIOutputBytes(result);
    // Aura TTS returns a ReadableStream. Tee it so usage accounting can measure
    // the audio bytes without consuming the stream returned to the caller.
    if(result&&typeof result.getReader==="function"&&typeof result.tee==="function"){
      const [callerStream,meterStream]=result.tee();
      result=callerStream;
      try{outputBytes=(await new Response(meterStream).arrayBuffer()).byteLength;}catch{}
    }
    const promptTokens=Number(usage.prompt_tokens??usage.input_tokens??usage.promptTokenCount),completionTokens=Number(usage.completion_tokens??usage.output_tokens??usage.candidatesTokenCount);
    const neuronsValue=Number(usage.neurons??result?.neurons??result?.response?.neurons);
    await env.DB.prepare("UPDATE ai_inference_events SET status='completed',duration_ms=?,output_bytes=?,prompt_tokens=?,completion_tokens=?,neurons=?,updated_at=unixepoch() WHERE id=?")
      .bind(Math.max(0,Date.now()-startedAt),outputBytes,
        Number.isFinite(promptTokens)?promptTokens:null,Number.isFinite(completionTokens)?completionTokens:null,
        Number.isFinite(neuronsValue)&&neuronsValue>0?neuronsValue:null,eventId).run();
    return result;
  }catch(error){
    await env.DB.prepare("UPDATE ai_inference_events SET status='failed',duration_ms=?,error_message=?,updated_at=unixepoch() WHERE id=?")
      .bind(Math.max(0,Date.now()-startedAt),String(error?.message||error).slice(0,300),eventId).run()
      .catch(trackError=>console.error(JSON.stringify({event:"ai_usage_tracking_update_failed",message:String(trackError?.message||trackError).slice(0,180)})));
    throw error;
  }
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

async function callAiProvider(env, provider, prompt, systemPrompt = null, temperature = 0.68) {
  const baseUrl = String(provider.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const endpoint = baseUrl + "/chat/completions";
  const headers = {
    "authorization": "Bearer " + provider.apiKey,
    "content-type": "application/json"
  };
  const model = provider.model || "gpt-4o-mini";
  const defaultSystemPrompt = "You are an expert YouTube storyteller, documentary writer, voice-over script editor, and metadata strategist. Write vivid, natural English that sounds like a skilled human narrator speaking to one person, not an essay being read aloud. Prioritize clear breath groups, effortless pronunciation, varied cadence, and emotional authenticity. Avoid repetitive wording, generic AI phrases, filler, fake suspense, and unsupported claims. Silently revise awkward sentences before returning. Optimize for viewer satisfaction and honest discoverability. Return one valid JSON object only; no markdown fences or commentary.";
  const messages = [
    { role: "system", content: systemPrompt || defaultSystemPrompt },
    { role: "user", content: prompt }
  ];

  async function requestJson(useJsonMode, tokenLimit = 3500) {
    const body = {
      model,
      temperature: Math.max(0, Math.min(1, Number(temperature) || 0.68)),
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
    try { return { script: await callAiProvider(env, primary, prompt), provider: "primary", model: primary.model || "gpt-4o-mini" }; }
    catch (error) { firstError = error; }
  }
  if (fallback.apiKey) {
    try { return { script: await callAiProvider(env, fallback, prompt), provider: "fallback", model: fallback.model || "configured fallback model" }; }
    catch (error) { throw new Error("Primary and fallback AI providers failed. " + (firstError?.message || "") + " " + error.message); }
  }
  if (firstError) throw firstError;
  throw new Error("AI provider is not configured. Add AI_API_KEY and AI_MODEL to Worker secrets/variables.");
}

async function translateSubtitleCues(env, cues) {
  if (!Array.isArray(cues) || !cues.length) return { cues: [], provider: "none", model: null };
  const providers = [
    { name: "primary", apiKey: env.AI_API_KEY, baseUrl: env.AI_BASE_URL, model: env.AI_MODEL },
    { name: "fallback", apiKey: env.AI_FALLBACK_API_KEY, baseUrl: env.AI_FALLBACK_BASE_URL, model: env.AI_FALLBACK_MODEL }
  ].filter(provider => provider.apiKey);
  if (!providers.length) {
    throw new Error("Bahasa Indonesia subtitle translation is unavailable. Configure AI_API_KEY and AI_MODEL on the FacelessLab Worker.");
  }

  const systemPrompt = "You are a professional English-to-Indonesian subtitle localizer. Translate for natural spoken Bahasa Indonesia, not literal written prose. Preserve every fact, name, number, tone and intent. Keep each subtitle concise enough to read on a phone. Never merge, split, omit, reorder or add subtitle cues. Return exactly one valid JSON object with a translations array. Each item must contain the original numeric index and a translated text string. Do not include English source text, explanations, markdown or extra keys.";
  const translatedByIndex = new Map();
  let usedProvider = null;
  const chunkSize = 30;

  for (let offset = 0; offset < cues.length; offset += chunkSize) {
    const chunk = cues.slice(offset, offset + chunkSize);
    const input = chunk.map((cue, index) => ({
      index: offset + index + 1,
      text: String(cue.text || "").replace(/\s+/g, " ").trim()
    }));
    const prompt = [
      "Translate the following English video subtitle cues into Bahasa Indonesia.",
      "Keep the same order and one Indonesian translation for every index.",
      "Use natural, concise, conversational Indonesian suitable for an Indonesian audience. Preserve technical terms or proper names when translating them would be confusing.",
      "SOURCE CUES:",
      JSON.stringify(input),
      'REQUIRED JSON SHAPE: {"translations":[{"index":1,"text":"Terjemahan Bahasa Indonesia"}]}'
    ].join("\n");

    let result = null;
    let lastError = null;
    for (const provider of providers) {
      try {
        result = await callAiProvider(env, provider, prompt, systemPrompt, 0.18);
        usedProvider = provider;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!result) {
      throw new Error("English-to-Indonesian subtitle translation failed. " + String(lastError?.message || lastError || "Text AI provider unavailable").slice(0, 300));
    }

    const rows = Array.isArray(result.translations) ? result.translations : [];
    for (const row of rows) {
      const index = Number(row?.index);
      const text = String(row?.text || "").replace(/\s+/g, " ").trim().slice(0, 180);
      if (Number.isInteger(index) && index >= offset + 1 && index <= offset + chunk.length && text) {
        translatedByIndex.set(index, text);
      }
    }
    for (let index = offset + 1; index <= offset + chunk.length; index += 1) {
      if (!translatedByIndex.has(index)) {
        throw new Error("Indonesian subtitle translation was incomplete at caption " + index + ". Retry translation.");
      }
    }
  }

  return {
    cues: cues.map((cue, index) => ({ ...cue, text_id: translatedByIndex.get(index + 1) })),
    provider: usedProvider?.name || "configured",
    model: usedProvider?.model || "configured text model"
  };
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
  await env.DB.prepare("UPDATE generations SET status='completed',output_json=?,error_message=NULL,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(JSON.stringify({...script,_provider:result.provider,_provider_type:"external-api",_model:result.model}),generationId,userId).run();
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
  // Normalize narration for Aura-2 while preserving its wording and sentence order.
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
  if(!narration||narration.length>2000)throw new Error("Narration is empty or exceeds Aura-2's 2,000 character per request limit.");
  await env.DB.prepare("UPDATE generations SET status='processing',updated_at=unixepoch() WHERE id=? AND user_id=?").bind(generationId,userId).run();
  const model="@cf/deepgram/aura-1";
  const provider="cloudflare-workers-ai";
  const voice="luna";
  const result=await runTrackedAI(env,{user_id:userId,project_id:projectId,generation_id:generationId,stage:"voice",input_characters:narration.length},model,{text:narration,speaker:voice,encoding:"mp3"});
  const audioValue=result&&typeof result.getReader==="function"?result:(typeof result==="string"?result:result?.audio);
  let audio;
  if(result instanceof Response){
    audio=new Uint8Array(await result.arrayBuffer());
  }else if(audioValue&&typeof audioValue.getReader==="function"){
    audio=new Uint8Array(await new Response(audioValue).arrayBuffer());
  }else if(audioValue instanceof ArrayBuffer){
    audio=new Uint8Array(audioValue);
  }else if(ArrayBuffer.isView(audioValue)){
    audio=new Uint8Array(audioValue.buffer,audioValue.byteOffset,audioValue.byteLength);
  }else if(typeof audioValue==="string"){
    const value=audioValue.trim();
    if(value.startsWith("https://")||value.startsWith("http://")){
      const response=await fetch(value);
      if(!response.ok)throw new Error("Could not retrieve the generated MP3 audio file.");
      audio=new Uint8Array(await response.arrayBuffer());
    }else{
      const base64=value.startsWith("data:")?value.slice(value.indexOf("base64,")+7):value;
      const normalized=base64.replace(/-/g,"+").replace(/_/g,"/"),padded=normalized+"=".repeat((4-normalized.length%4)%4);
      const binary=atob(padded);
      audio=new Uint8Array(binary.length);
      for(let i=0;i<binary.length;i++)audio[i]=binary.charCodeAt(i);
    }
  }else{
    throw new Error("Aura-1 returned an unsupported audio response.");
  }
  if(!audio||!audio.byteLength)throw new Error("Aura-1 returned an empty audio file.");
  const mimeType="audio/mpeg";
  const objectKey="users/"+userId+"/projects/"+projectId+"/voice/"+generationId+".mp3";
  await env.MEDIA.put(objectKey,audio,{httpMetadata:{contentType:mimeType,cacheControl:"private, max-age=3600"},customMetadata:{userId,projectId,generationId}});
  const output={object_key:objectKey,mime_type:mimeType,bytes:audio.byteLength,provider,model,language:"en",voice,characters:narration.length,source_characters:rawNarration.length,preprocessing:"punctuation-and-whitespace-normalized"};
  await env.DB.prepare("UPDATE generations SET status='completed',output_json=?,error_message=NULL,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(JSON.stringify(output),generationId,userId).run();
  console.log(JSON.stringify({event:"background_voice_completed",generation_id:generationId,project_id:projectId}));message.ack();
 }catch(error){
  const detail=String(error?.message||error).slice(0,500),attempts=Number(message.attempts||1);
  console.error(JSON.stringify({event:"background_voice_attempt_failed",generation_id:generationId,attempts,error:detail}));
  if(["AI_DAILY_LIMIT_REACHED","AI_DAILY_APP_LIMIT_REACHED","AI_DAILY_TTS_LIMIT_REACHED","AI_ACCOUNT_NEURON_SOFT_STOP"].includes(error?.code)||attempts>=3){await env.DB.prepare("UPDATE generations SET status='failed',error_message=?,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(detail,generationId,userId).run();message.ack();}
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
  const fail=(message)=>Response.redirect((env.APP_ORIGIN||"https://facelesslab.pages.dev")+"/?oauth_error="+encodeURIComponent(message)+"#publishing",302);
  if(url.searchParams.get("error"))return fail("Authorization was cancelled.");
  if(!state||!code)return fail("The authorization response is missing its state or code.");
  const stateRow=await env.DB.prepare("SELECT user_id,platform,expires_at FROM oauth_states WHERE state=?").bind(state).first();
  await env.DB.prepare("DELETE FROM oauth_states WHERE state=?").bind(state).run();
  if(!stateRow||stateRow.platform!==platform||Number(stateRow.expires_at)<Math.floor(Date.now()/1000))return fail("Authorization expired. Please connect again.");
  const redirectUri=new URL(request.url).origin+"/api/publishing/oauth/"+platform+"/callback";
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
  return Response.redirect((env.APP_ORIGIN||"https://facelesslab.pages.dev")+"/?connected="+platform+"#publishing",302);
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
async function updateProductionScheduleForPublishJob(env,jobId,status,errorMessage=null){
  try{
    await env.DB.prepare("UPDATE production_schedules SET status=?,error_message=?,updated_at=unixepoch() WHERE publish_job_id=?")
      .bind(status,errorMessage?String(errorMessage).slice(0,500):null,jobId).run();
  }catch(error){
    console.error(JSON.stringify({event:"production_schedule_status_sync_failed",job_id:jobId,error:String(error?.message||error).slice(0,240)}));
  }
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
   if(typeof FixedLengthStream!=="function")throw new Error("Cloudflare fixed-length upload streaming is unavailable in this Worker runtime.");
   if(!object.body)throw new Error("Cloud backup has no readable MP4 stream.");
   let tagCandidates=[];
   try{const savedTags=JSON.parse(String(job.tags_json||"[]"));if(Array.isArray(savedTags))tagCandidates=savedTags;}catch{}
   if(!tagCandidates.length)tagCandidates=[...new Set((String(job.hashtags||"").match(/#[\p{L}\p{N}_]+/gu)||[]).map(x=>x.slice(1)))];
   const tags=[],seenTags=new Set();let tagBytes=0;
   for(const value of tagCandidates){
    const tag=String(value||"").trim().replace(/^#+/,"").replace(/\s+/g," ");
    if(!tag)continue;
    const key=tag.toLocaleLowerCase();if(seenTags.has(key))continue;
    const cost=encoder.encode(tag).byteLength+(tags.length?1:0);
    if(tags.length>=30||tagBytes+cost>500)break;
    seenTags.add(key);tags.push(tag);tagBytes+=cost;
   }
   let description=String(job.description||"")+(job.hashtags?"\n\n"+String(job.hashtags):"");
   if(encoder.encode(description).byteLength>5000){
    let clipped="",used=0;
    for(const character of description){const size=encoder.encode(character).byteLength;if(used+size>5000)break;clipped+=character;used+=size;}
    description=clipped;
   }
   const snippet={title:String(job.title||"FacelessLab video").slice(0,100),description,categoryId:"24"};
   // Automated English Kenji anime episodes use Film & Animation; retain the existing default for other uploads.
   if(/^Part\s+\d+\s*:/i.test(snippet.title)&&/\b(Kenji|Neo[- ]Tokyo)\b/i.test(description)){
    snippet.categoryId="1";snippet.defaultLanguage="en";snippet.defaultAudioLanguage="en";
   }
   if(tags.length)snippet.tags=tags;
   const metadata={snippet,status:{privacyStatus:["public","unlisted","private"].includes(job.privacy)?job.privacy:"private"}};
   const init=await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",{method:"POST",headers:{authorization:"Bearer "+access,"content-type":"application/json; charset=UTF-8","x-upload-content-type":"video/mp4","x-upload-content-length":String(size)},body:JSON.stringify(metadata)});
   if(!init.ok)throw new Error("YouTube upload setup failed: "+(await init.text()).slice(0,500));
   const location=init.headers.get("location");if(!location)throw new Error("YouTube did not return an upload URL.");
   const fixedBody=new FixedLengthStream(size);
   const streamPump=object.body.pipeTo(fixedBody.writable);
   let uploaded;
   try{
    uploaded=await fetch(location,{method:"PUT",headers:{"content-type":"video/mp4"},body:fixedBody.readable});
    await streamPump;
   }catch(uploadError){
    await streamPump.catch(()=>{});
    throw uploadError;
   }
   const result=await uploaded.json().catch(()=>({}));
   if(!uploaded.ok||!result.id)throw new Error("YouTube upload failed (HTTP "+uploaded.status+"): "+JSON.stringify(result.error||result).slice(0,500));
   const videoUrl="https://www.youtube.com/shorts/"+result.id;
   await env.DB.prepare("UPDATE publish_jobs SET status='processing',provider_post_id=?,provider_url=?,error_message=NULL,updated_at=unixepoch() WHERE id=?").bind(result.id,videoUrl,id).run();
   await env.JOBS.send({type:"check_youtube_status",job_id:id,attempt:1},{delaySeconds:30});
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
   const status=await check.json().catch(()=>({}));if(status.data?.status==="PUBLISH_COMPLETE"){await env.DB.prepare("UPDATE publish_jobs SET status='published',provider_url=?,updated_at=unixepoch() WHERE id=?").bind(status.data?.share_url||null,id).run();await updateProductionScheduleForPublishJob(env,id,"published");}else if(status.data?.status==="FAILED")throw new Error(status.data.fail_reason||"TikTok rejected the video.");else await env.JOBS.send({type:"check_tiktok_status",job_id:id,attempt:1},{delaySeconds:30});
  }
 }catch(error){const detail=String(error?.message||error).slice(0,700);await env.DB.prepare("UPDATE publish_jobs SET status='failed',error_message=?,updated_at=unixepoch() WHERE id=?").bind(detail,id).run();await updateProductionScheduleForPublishJob(env,id,"failed",detail);throw error;}
}


async function processYouTubeStatusMessage(message,env) {
 const id=message.body?.job_id,attempt=Math.max(1,Number(message.body?.attempt||1));
 if(!id)return;
 const job=await env.DB.prepare("SELECT * FROM publish_jobs WHERE id=? AND platform='youtube' AND status='processing'").bind(id).first();
 if(!job||!job.provider_post_id)return;
 const connection=await env.DB.prepare("SELECT * FROM social_connections WHERE id=? AND user_id=? AND status='active'").bind(job.connection_id,job.user_id).first();
 if(!connection){
  await env.DB.prepare("UPDATE publish_jobs SET error_message='Reconnect the YouTube channel, then refresh this upload status.',updated_at=unixepoch() WHERE id=?").bind(id).run();
  return;
 }
 let response,data;
 try{
  const access=await getFreshSocialAccessToken(env,connection);
  const endpoint="https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id="+encodeURIComponent(job.provider_post_id);
  response=await fetch(endpoint,{headers:{authorization:"Bearer "+access}});
  data=await response.json().catch(()=>({}));
 }catch(error){
  if(attempt<20){await env.JOBS.send({type:"check_youtube_status",job_id:id,attempt:attempt+1},{delaySeconds:Math.min(120,attempt*15)});return;}
  await env.DB.prepare("UPDATE publish_jobs SET error_message=?,updated_at=unixepoch() WHERE id=?")
   .bind("YouTube processing status could not be confirmed: "+String(error?.message||error).slice(0,400),id).run();
  return;
 }
 if(!response.ok){
  const detail=String(data.error?.message||"YouTube status request failed").slice(0,400);
  if((response.status===429||response.status>=500)&&attempt<20){
   await env.JOBS.send({type:"check_youtube_status",job_id:id,attempt:attempt+1},{delaySeconds:Math.min(120,attempt*15)});return;
  }
  await env.DB.prepare("UPDATE publish_jobs SET error_message=?,updated_at=unixepoch() WHERE id=?")
   .bind("YouTube status check (HTTP "+response.status+"): "+detail,id).run();
  return;
 }
 const video=data.items?.[0];
 if(!video){
  if(attempt<20){await env.JOBS.send({type:"check_youtube_status",job_id:id,attempt:attempt+1},{delaySeconds:30});return;}
  await env.DB.prepare("UPDATE publish_jobs SET error_message='Upload received by YouTube, but its processing record is not available yet. Open the video in YouTube Studio and refresh this status later.',updated_at=unixepoch() WHERE id=?").bind(id).run();
  return;
 }
 const uploadStatus=String(video.status?.uploadStatus||"").toLowerCase();
 const processingStatus=String(video.processingDetails?.processingStatus||"").toLowerCase();
 if(uploadStatus==="processed"||processingStatus==="succeeded"){
  await env.DB.prepare("UPDATE publish_jobs SET status='published',error_message=NULL,updated_at=unixepoch() WHERE id=?").bind(id).run();
  await updateProductionScheduleForPublishJob(env,id,"published");
  return;
 }
 if(["failed","rejected","deleted"].includes(uploadStatus)||processingStatus==="failed"||processingStatus==="rejected"){
  const reason=video.status?.rejectionReason||video.status?.failureReason||video.processingDetails?.processingFailureReason||uploadStatus||processingStatus||"unknown";
  await env.DB.prepare("UPDATE publish_jobs SET status='failed',error_message=?,updated_at=unixepoch() WHERE id=?")
   .bind("YouTube could not process this upload: "+String(reason).slice(0,400),id).run();
  await updateProductionScheduleForPublishJob(env,id,"failed","YouTube could not process this upload: "+String(reason).slice(0,400));
  return;
 }
 if(attempt<20){
  await env.JOBS.send({type:"check_youtube_status",job_id:id,attempt:attempt+1},{delaySeconds:30});
 }else{
  await env.DB.prepare("UPDATE publish_jobs SET error_message='YouTube is still processing this video. The upload was received; open the video in YouTube Studio and use Refresh status here later. Do not upload it again unless YouTube confirms the upload failed.',updated_at=unixepoch() WHERE id=?").bind(id).run();
 }
}

async function processTikTokStatusMessage(message,env) {
 const id=message.body?.job_id,attempt=Number(message.body?.attempt||1);
 const job=await env.DB.prepare("SELECT * FROM publish_jobs WHERE id=? AND platform='tiktok' AND status='processing'").bind(id).first();if(!job)return;
 const connection=await env.DB.prepare("SELECT * FROM social_connections WHERE id=? AND user_id=? AND status='active'").bind(job.connection_id,job.user_id).first();if(!connection)throw new Error("TikTok connection is no longer available.");
 const access=await getFreshSocialAccessToken(env,connection);
 const response=await fetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/",{method:"POST",headers:{authorization:"Bearer "+access,"content-type":"application/json"},body:JSON.stringify({publish_id:job.provider_post_id})});
 const data=await response.json().catch(()=>({}));if(!response.ok||data.error?.code!=="ok")throw new Error(data.error?.message||"TikTok status check failed.");
 const state=data.data?.status||"";
 if(state==="PUBLISH_COMPLETE"){
  await env.DB.prepare("UPDATE publish_jobs SET status='published',provider_url=?,updated_at=unixepoch() WHERE id=?").bind(data.data?.share_url||null,id).run();
  await updateProductionScheduleForPublishJob(env,id,"published");
 }else if(state==="FAILED"){
  await env.DB.prepare("UPDATE publish_jobs SET status='failed',error_message=?,updated_at=unixepoch() WHERE id=?").bind(String(data.data?.fail_reason||"TikTok could not publish this video.").slice(0,700),id).run();
  await updateProductionScheduleForPublishJob(env,id,"failed",String(data.data?.fail_reason||"TikTok could not publish this video.").slice(0,700));
 }else if(attempt<20){
  await env.JOBS.send({type:"check_tiktok_status",job_id:id,attempt:attempt+1},{delaySeconds:30});
 }else{
  await env.DB.prepare("UPDATE publish_jobs SET error_message='TikTok is still processing. Refresh status or check the TikTok account.',updated_at=unixepoch() WHERE id=?").bind(id).run();
 }
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

    if (path.startsWith("/api/admin/")) {
      if (user.role !== "admin") return json({ ok: false, error: "Administrator access required." }, 403);

      if (path === "/api/admin/cloudflare-billing" && method === "GET") {
        if (!env.CF_API_TOKEN) return json({ ok: false, error: "Cloudflare billing token is not configured." }, 503);
        const accountId = "7fba808c5a694f2755dc45ab94cee505";
        const headers = { authorization: "Bearer " + env.CF_API_TOKEN, accept: "application/json" };
        const requestBilling = async (endpoint) => {
          try {
            const response = await fetch("https://api.cloudflare.com/client/v4" + endpoint, {
              headers, signal: AbortSignal.timeout(12000)
            });
            const payload = await response.json().catch(() => ({}));
            return { http_status: response.status, success: response.ok && payload.success === true, result: payload.result ?? null,
              errors: (payload.errors || []).map(item => ({ code: item.code, message: String(item.message || "").slice(0, 180) })) };
          } catch (error) {
            return { http_status: 0, success: false, result: null, errors: [{ message: String(error.message || error).slice(0, 180) }] };
          }
        };
        const analyticsTodayUtc = new Date().toISOString().slice(0,10);
        const analyticsSevenDaysAgoUtc = new Date(Date.now()-6*86400000).toISOString().slice(0,10);
        const [credits, billable, aiAnalytics] = await Promise.all([
          requestBilling("/accounts/" + accountId + "/billing/credits"),
          requestBilling("/accounts/" + accountId + "/billable-usage"),
          fetchCloudflareAiAnalytics(env,analyticsSevenDaysAgoUtc,analyticsTodayUtc)
        ]);
        const rows = Array.isArray(billable.result) ? billable.result : [];
        const services = {};
        let totalCost = 0;
        const records = rows.map((row, index) => {
          const serviceName = String(row.ServiceName || row.ServiceFamilyName || "Other").slice(0, 100);
          const family = String(row.ServiceFamilyName || serviceName).slice(0, 80);
          const rawCost = Number(row.BilledCost ?? row.EffectiveCost ?? row.ContractedCost ?? 0);
          const cost = Number.isFinite(rawCost) ? rawCost : 0;
          totalCost += cost;
          if (!services[family]) services[family] = { cost: 0, records: 0, services: {} };
          services[family].cost += cost;
          services[family].records += 1;
          if (!services[family].services[serviceName]) services[family].services[serviceName] = { cost: 0, records: 0 };
          services[family].services[serviceName].cost += cost;
          services[family].services[serviceName].records += 1;
          return {
            id: index + 1, service: serviceName, family,
            description: String(row.ChargeDescription || "").slice(0, 180),
            quantity: Number.isFinite(Number(row.ConsumedQuantity)) ? Number(row.ConsumedQuantity) : null,
            unit: String(row.ConsumedUnit || row.PricingUnit || "").slice(0, 40),
            pricing_quantity: Number.isFinite(Number(row.PricingQuantity)) ? Number(row.PricingQuantity) : null,
            pricing_unit: String(row.PricingUnit || "").slice(0, 40),
            metric_id: String(row.x_BillableMetricId || row.BillableMetricId || "").slice(0, 120),
            metric_name: String(row.x_BillableMetricName || row.BillableMetricName || "").slice(0, 140),
            cumulative_quantity: Number.isFinite(Number(row.CumulatedPricingQuantity)) ? Number(row.CumulatedPricingQuantity) : null,
            cumulative_cost: Number.isFinite(Number(row.CumulatedContractedCost)) ? Number(row.CumulatedContractedCost) : null,
            cost: Number(cost.toFixed(6)),
            currency: String(row.BillingCurrency || "USD").slice(0, 8),
            charge_start: row.ChargePeriodStart || null,
            charge_end: row.ChargePeriodEnd || null,
            billing_period: row.BillingPeriodStart || null
          };
        }).sort((a, b) => String(b.charge_start || "").localeCompare(String(a.charge_start || "")));
        const periods = records.map(row => row.charge_start).filter(Boolean).sort();
        const todayUtc = new Date().toISOString().slice(0, 10);
        const workersAiRecords = records.filter(row => (row.family + " " + row.service).toLowerCase().includes("workers ai"));
        const neuronRecords = records.filter(row => /neuron/i.test(row.unit + " " + row.metric_name + " " + row.description));
        const neuronTotal = neuronRecords.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
        const neuronToday = neuronRecords.filter(row => String(row.charge_start || "").slice(0, 10) === todayUtc)
          .reduce((sum, row) => sum + Number(row.quantity || 0), 0);
        const dailyUsage = {};
        for (const row of records) {
          const day = String(row.charge_start || "").slice(0, 10);
          if (!day) continue;
          if (!dailyUsage[day]) dailyUsage[day] = { date: day, records: 0, cost: 0, quantity_by_unit: {} };
          dailyUsage[day].records++;
          dailyUsage[day].cost += Number(row.cost || 0);
          const unit = row.unit || "count";
          dailyUsage[day].quantity_by_unit[unit] = (dailyUsage[day].quantity_by_unit[unit] || 0) + Number(row.quantity || 0);
        }
        const credit = credits.result && typeof credits.result === "object" ? credits.result : null;
        const creditSummary = credit ? {
          eligible: credit.eligible === true,
          has_record: credit.has_record === true,
          confirmed_balance: Number.isFinite(Number(credit.confirmed_balance_cents)) ? Number(credit.confirmed_balance_cents) / 100 : null,
          original_amount: Number.isFinite(Number(credit.original_amount_cents)) ? Number(credit.original_amount_cents) / 100 : null,
          days_remaining: Number.isFinite(Number(credit.days_remaining)) ? Number(credit.days_remaining) : null,
          percent_consumed: Number.isFinite(Number(credit.percent_consumed)) ? Number(credit.percent_consumed) : null
        } : null;
        return json({
          ok: credits.success || billable.success,
          checked_at: new Date().toISOString(),
          credits: { success: credits.success, http_status: credits.http_status, result: credits.result, summary: creditSummary, errors: credits.errors },
          ai_analytics: aiAnalytics,
          billable_usage: {
            success: billable.success, http_status: billable.http_status,
            billing_period: rows[0]?.BillingPeriodStart || null,
            period_from: periods[0] || null, period_to: periods[periods.length - 1] || null,
            currency: rows[0]?.BillingCurrency || "USD",
            total_billed_cost: Number(totalCost.toFixed(6)), record_count: rows.length,
            workers_ai_record_count: workersAiRecords.length,
            neuron_usage: {
              available: neuronRecords.length > 0,
              reported_total: neuronRecords.length ? Number(neuronTotal.toFixed(4)) : null,
              reported_today: neuronRecords.length ? Number(neuronToday.toFixed(4)) : null,
              unit: neuronRecords[0]?.unit || null,
              records: neuronRecords.length,
              freshness_note: "Cloudflare billable usage data is updated daily and is not a live Neurons meter."
            },
            daily_usage: Object.values(dailyUsage).sort((a,b) => a.date.localeCompare(b.date)).map(day => ({
              ...day, cost: Number(day.cost.toFixed(6))
            })),
            workers_ai_records: workersAiRecords,
            services: Object.entries(services).map(([name, value]) => ({
              name, cost: Number(value.cost.toFixed(6)), records: value.records,
              products: Object.entries(value.services).map(([product, item]) => ({ name: product, cost: Number(item.cost.toFixed(6)), records: item.records }))
            })).sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name)),
            records, errors: billable.errors
          }
        });
      }

      if (path === "/api/admin/ai-usage-settings" && method === "POST") {
        const body = await request.json().catch(() => null);
        const limit = Number(body?.daily_request_limit);
        if (!Number.isSafeInteger(limit) || (limit !== 0 && (limit < 5 || limit > 500))) {
          return json({ok:false,error:"Daily non-admin member Workers AI request cap must be 0 (disabled) or a whole number from 5 to 500."},400);
        }
        await env.DB.prepare("INSERT INTO ai_usage_settings (id,daily_request_limit,warning_percent,updated_at) VALUES ('global',?,?,unixepoch()) ON CONFLICT(id) DO UPDATE SET daily_request_limit=excluded.daily_request_limit,warning_percent=excluded.warning_percent,updated_at=unixepoch()")
          .bind(limit,80).run();
        await env.DB.prepare("INSERT INTO admin_audit_logs (id,actor_id,action,details_json) VALUES (?,?,?,?)")
          .bind(crypto.randomUUID(),user.id,"ai_usage_safety_cap",JSON.stringify({daily_request_limit:limit,warning_percent:80})).run();
        return json({ok:true,settings:await readAIUsageSettings(env)});
      }

      if (path === "/api/admin/ai-usage" && method === "GET") {
        const period = String(url.searchParams.get("period") || "30d");
        const periodSeconds = period === "7d" ? 7 * 86400 : period === "90d" ? 90 * 86400 : period === "all" ? 0 : 30 * 86400;
        const since = periodSeconds ? Math.floor(Date.now() / 1000) - periodSeconds : 0;
        const q = String(url.searchParams.get("q") || "").trim().slice(0, 100).toLowerCase();
        const [totals, members, models, recent] = await Promise.all([
          env.DB.prepare(`
            SELECT COUNT(*) AS total_jobs,
              SUM(CASE WHEN stage IN ('voice','visuals','character_reference','subtitles') THEN 1 ELSE 0 END) AS cloudflare_ai_jobs,
              SUM(CASE WHEN stage='script' THEN 1 ELSE 0 END) AS external_script_jobs,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed_jobs,
              SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed_jobs,
              SUM(CASE WHEN status IN ('queued','processing') THEN 1 ELSE 0 END) AS pending_jobs,
              SUM(CASE WHEN stage='voice' THEN COALESCE(CAST(json_extract(input_json,'$.characters') AS INTEGER),CAST(json_extract(output_json,'$.source_characters') AS INTEGER),0) ELSE 0 END) AS tts_characters,
              SUM(CASE WHEN stage='visuals' THEN 1 ELSE 0 END) AS scene_image_jobs,
              SUM(CASE WHEN stage='character_reference' THEN 1 ELSE 0 END) AS character_image_jobs,
              SUM(CASE WHEN stage='subtitles' THEN COALESCE(CAST(json_extract(input_json,'$.audio_bytes') AS INTEGER),0) ELSE 0 END) AS subtitle_audio_bytes,
              COUNT(DISTINCT user_id) AS active_users
            FROM generations WHERE created_at >= ?
          `).bind(since).first(),
          env.DB.prepare(`
            SELECT u.id,u.email,u.display_name,u.role,u.status,u.created_at,
              COUNT(g.id) AS total_jobs,
              SUM(CASE WHEN g.stage='script' THEN 1 ELSE 0 END) AS script_jobs,
              SUM(CASE WHEN g.stage='voice' THEN 1 ELSE 0 END) AS voice_jobs,
              SUM(CASE WHEN g.stage='visuals' THEN 1 ELSE 0 END) AS scene_image_jobs,
              SUM(CASE WHEN g.stage='character_reference' THEN 1 ELSE 0 END) AS character_image_jobs,
              SUM(CASE WHEN g.stage='subtitles' THEN 1 ELSE 0 END) AS subtitle_jobs,
              SUM(CASE WHEN g.stage IN ('voice','visuals','character_reference','subtitles') THEN 1 ELSE 0 END) AS cloudflare_ai_jobs,
              SUM(CASE WHEN g.status='failed' THEN 1 ELSE 0 END) AS failed_jobs,
              SUM(CASE WHEN g.stage='voice' THEN COALESCE(CAST(json_extract(g.input_json,'$.characters') AS INTEGER),CAST(json_extract(g.output_json,'$.source_characters') AS INTEGER),0) ELSE 0 END) AS tts_characters,
              SUM(CASE WHEN g.stage='subtitles' THEN COALESCE(CAST(json_extract(g.input_json,'$.audio_bytes') AS INTEGER),0) ELSE 0 END) AS subtitle_audio_bytes,
              MAX(g.created_at) AS last_activity
            FROM users u JOIN generations g ON g.user_id=u.id
            WHERE g.created_at >= ? AND (?='' OR lower(u.email) LIKE '%'||?||'%' OR lower(COALESCE(u.display_name,'')) LIKE '%'||?||'%')
            GROUP BY u.id
            ORDER BY total_jobs DESC, last_activity DESC LIMIT 100
          `).bind(since,q,q,q).all(),
          env.DB.prepare(`
            SELECT stage,
              CASE WHEN stage='script' THEN COALESCE(json_extract(output_json,'$._model'),'External API model not recorded')
                   ELSE COALESCE(json_extract(output_json,'$.model'),json_extract(input_json,'$.model'),'Model not recorded') END AS model,
              COUNT(*) AS jobs,
              SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
            FROM generations WHERE created_at >= ?
            GROUP BY stage,model ORDER BY jobs DESC,stage,model LIMIT 30
          `).bind(since).all(),
          env.DB.prepare(`
            SELECT g.id,g.stage,g.status,g.created_at,p.title AS project_title,
              u.email,u.display_name,u.role,
              CASE WHEN g.stage='script' THEN COALESCE(json_extract(g.output_json,'$._model'),'External API model not recorded')
                   ELSE COALESCE(json_extract(g.output_json,'$.model'),json_extract(g.input_json,'$.model'),'Model not recorded') END AS model
            FROM generations g
            JOIN users u ON u.id=g.user_id
            LEFT JOIN projects p ON p.id=g.project_id
            WHERE g.created_at >= ?
            ORDER BY g.created_at DESC LIMIT 15
          `).bind(since).all()
        ]);

        const usageSettings = await readAIUsageSettings(env);
        const nowUtc = Math.floor(Date.now() / 1000);
        const utcDayStart = Math.floor(nowUtc / 86400) * 86400;
        const [todayTotals, todayStages, dailyHistory, recentInferences, dailyCounter] = await Promise.all([
          env.DB.prepare(
            "SELECT COUNT(*) AS requests," +
            "SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed," +
            "SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed," +
            "SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) AS processing," +
            "SUM(COALESCE(neurons,0)) AS reported_neurons," +
            "SUM(CASE WHEN neurons IS NOT NULL THEN 1 ELSE 0 END) AS neuron_records," +
            "SUM(COALESCE(prompt_tokens,0)) AS prompt_tokens," +
            "SUM(COALESCE(completion_tokens,0)) AS completion_tokens," +
            "SUM(COALESCE(input_characters,0)) AS input_characters," +
            "SUM(COALESCE(input_bytes,0)) AS input_bytes," +
            "SUM(COALESCE(output_bytes,0)) AS output_bytes FROM (" +
            "SELECT status,neurons,prompt_tokens,completion_tokens,input_characters,input_bytes,output_bytes " +
            "FROM ai_inference_events WHERE created_at>=? " +
            "UNION ALL SELECT status,NULL,NULL,NULL," +
            "COALESCE(CAST(json_extract(input_json,'$.characters') AS INTEGER),0)," +
            "COALESCE(CAST(json_extract(input_json,'$.audio_bytes') AS INTEGER),0)," +
            "COALESCE(CAST(json_extract(output_json,'$.bytes') AS INTEGER),0) " +
            "FROM generations g WHERE g.created_at>=? " +
            "AND g.stage IN ('voice','visuals','character_reference','subtitles') " +
            "AND NOT EXISTS (SELECT 1 FROM ai_inference_events e WHERE e.generation_id=g.id))"
          ).bind(utcDayStart,utcDayStart).first(),
          env.DB.prepare(
            "SELECT stage,model,COUNT(*) AS requests," +
            "SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed," +
            "SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed," +
            "SUM(COALESCE(prompt_tokens,0)) AS prompt_tokens," +
            "SUM(COALESCE(completion_tokens,0)) AS completion_tokens," +
            "SUM(COALESCE(input_characters,0)) AS input_characters," +
            "SUM(COALESCE(input_bytes,0)) AS input_bytes," +
            "SUM(COALESCE(output_bytes,0)) AS output_bytes," +
            "SUM(COALESCE(neurons,0)) AS reported_neurons,AVG(duration_ms) AS avg_duration_ms FROM (" +
            "SELECT stage,model,status,prompt_tokens,completion_tokens,input_characters,input_bytes,output_bytes,neurons,duration_ms " +
            "FROM ai_inference_events WHERE created_at>=? " +
            "UNION ALL SELECT g.stage," +
            "COALESCE(json_extract(g.output_json,'$.model'),json_extract(g.input_json,'$.model'),'Model not recorded')," +
            "g.status,NULL,NULL," +
            "COALESCE(CAST(json_extract(g.input_json,'$.characters') AS INTEGER),0)," +
            "COALESCE(CAST(json_extract(g.input_json,'$.audio_bytes') AS INTEGER),0)," +
            "COALESCE(CAST(json_extract(g.output_json,'$.bytes') AS INTEGER),0),NULL,NULL " +
            "FROM generations g WHERE g.created_at>=? " +
            "AND g.stage IN ('voice','visuals','character_reference','subtitles') " +
            "AND NOT EXISTS (SELECT 1 FROM ai_inference_events e WHERE e.generation_id=g.id)) " +
            "GROUP BY stage,model ORDER BY requests DESC,stage,model"
          ).bind(utcDayStart,utcDayStart).all(),
          env.DB.prepare(
            "SELECT date(created_at,'unixepoch') AS day,stage,COUNT(*) AS requests FROM (" +
            "SELECT created_at,stage FROM ai_inference_events WHERE created_at>=? " +
            "UNION ALL SELECT g.created_at,g.stage FROM generations g WHERE g.created_at>=? " +
            "AND g.stage IN ('voice','visuals','character_reference','subtitles') " +
            "AND NOT EXISTS (SELECT 1 FROM ai_inference_events e WHERE e.generation_id=g.id)) " +
            "GROUP BY day,stage ORDER BY day,stage"
          ).bind(nowUtc-7*86400,nowUtc-7*86400).all(),
          env.DB.prepare(
            "SELECT e.id,e.stage,e.model,e.status,e.created_at,e.duration_ms,e.input_characters,e.input_bytes," +
            "e.output_bytes,e.prompt_tokens,e.completion_tokens,e.neurons,u.email,u.display_name,p.title AS project_title " +
            "FROM ai_inference_events e JOIN users u ON u.id=e.user_id " +
            "LEFT JOIN projects p ON p.id=e.project_id WHERE e.created_at>=? " +
            "ORDER BY e.created_at DESC LIMIT 25"
          ).bind(utcDayStart).all(),
          env.DB.prepare("SELECT analytics_requests,pending_requests,analytics_neurons,member_requests,faceless_requests,tts_characters FROM ai_usage_daily_counters WHERE utc_date=?")
            .bind(new Date().toISOString().slice(0,10)).first()
        ]);
        const n = value => Number(value || 0);
        return json({
          ok: true, period, since,
          totals: {
            total_jobs:n(totals?.total_jobs),cloudflare_ai_jobs:n(totals?.cloudflare_ai_jobs),
            external_script_jobs:n(totals?.external_script_jobs),failed_jobs:n(totals?.failed_jobs),
            completed_jobs:n(totals?.completed_jobs),pending_jobs:n(totals?.pending_jobs),
            tts_characters:n(totals?.tts_characters),scene_image_jobs:n(totals?.scene_image_jobs),
            character_image_jobs:n(totals?.character_image_jobs),subtitle_audio_bytes:n(totals?.subtitle_audio_bytes),
            active_users:n(totals?.active_users)
          },
          members: members.results || [],
          models: models.results || [],
          recent: recent.results || [],
          settings: usageSettings,
          today: {
            utc_day_start: utcDayStart,
            requests: n(todayTotals?.requests),
            guard_requests: n(dailyCounter?.member_requests),
            guard_neurons: n(dailyCounter?.analytics_neurons),
            faceless_requests: n(dailyCounter?.faceless_requests),
            faceless_request_cap: FACELESSLAB_DAILY_AI_REQUEST_LIMIT,
            tts_characters: n(dailyCounter?.tts_characters),
            tts_character_cap: FACELESSLAB_DAILY_TTS_CHARACTER_LIMIT,
            neuron_soft_stop: FACELESSLAB_ACCOUNT_NEURON_SOFT_STOP,
            completed: n(todayTotals?.completed),
            failed: n(todayTotals?.failed),
            processing: n(todayTotals?.processing),
            reported_neurons: n(todayTotals?.neuron_records) ? n(todayTotals?.reported_neurons) : null,
            neuron_records: n(todayTotals?.neuron_records),
            prompt_tokens: n(todayTotals?.prompt_tokens),
            completion_tokens: n(todayTotals?.completion_tokens),
            input_characters: n(todayTotals?.input_characters),
            input_bytes: n(todayTotals?.input_bytes),
            output_bytes: n(todayTotals?.output_bytes),
            cap: usageSettings.daily_request_limit,
            warning_at: usageSettings.daily_request_limit ? Math.ceil(usageSettings.daily_request_limit * usageSettings.warning_percent / 100) : null
          },
          today_by_model: todayStages.results || [],
          last_7_days: dailyHistory.results || [],
          recent_inferences: recentInferences.results || [],
          accounting_note: "FacelessLab pauses after 80 total daily model calls, 10,000 daily TTS characters, or when account-wide Workers AI analytics reaches 8,000 Neurons. Cloudflare Analytics may be delayed; other Workers and Pages projects still share the account allowance. Exact USD charges remain account-level billing data."
        });
      }

      if (path === "/api/admin/overview" && method === "GET") {
        const [members, activeMembers, suspendedMembers, projects, generations, publishJobs, points] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS count FROM users").first(),
          env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE status='active'").first(),
          env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE status='suspended'").first(),
          env.DB.prepare("SELECT COUNT(*) AS count FROM projects").first(),
          env.DB.prepare("SELECT COUNT(*) AS count FROM generations").first(),
          env.DB.prepare("SELECT COUNT(*) AS count FROM publish_jobs").first(),
          env.DB.prepare("SELECT COALESCE(SUM(balance),0) AS total FROM wallets").first()
        ]);
        const audit = await env.DB.prepare(
          "SELECT a.id,a.action,a.details_json,a.created_at,u.email AS target_email,actor.email AS actor_email FROM admin_audit_logs a LEFT JOIN users u ON u.id=a.target_user_id LEFT JOIN users actor ON actor.id=a.actor_id ORDER BY a.created_at DESC LIMIT 8"
        ).all();
        return json({ ok: true, stats: {
          members: Number(members?.count || 0), active_members: Number(activeMembers?.count || 0),
          suspended_members: Number(suspendedMembers?.count || 0), projects: Number(projects?.count || 0),
          generations: Number(generations?.count || 0), publish_jobs: Number(publishJobs?.count || 0),
          points_in_circulation: Number(points?.total || 0)
        }, audit: audit.results || [] });
      }

      if (path === "/api/admin/users" && method === "GET") {
        const q = String(url.searchParams.get("q") || "").trim().slice(0, 100);
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 25)));
        const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
        const result = await env.DB.prepare(
          "SELECT u.id,u.email,u.display_name,u.role,u.status,u.created_at,COALESCE(w.balance,0) AS points,(SELECT COUNT(*) FROM projects p WHERE p.user_id=u.id) AS project_count,(SELECT COUNT(*) FROM generations g WHERE g.user_id=u.id) AS generation_count,(SELECT COUNT(*) FROM publish_jobs j WHERE j.user_id=u.id) AS publish_count FROM users u LEFT JOIN wallets w ON w.user_id=u.id WHERE (?='' OR lower(u.email) LIKE '%'||lower(?)||'%' OR lower(COALESCE(u.display_name,'')) LIKE '%'||lower(?)||'%') ORDER BY u.created_at DESC LIMIT ? OFFSET ?"
        ).bind(q, q, q, limit, offset).all();
        const count = await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM users WHERE (?='' OR lower(email) LIKE '%'||lower(?)||'%' OR lower(COALESCE(display_name,'')) LIKE '%'||lower(?)||'%')"
        ).bind(q, q, q).first();
        return json({ ok: true, users: result.results || [], total: Number(count?.count || 0), limit, offset });
      }

      const statusMatch = path.match(/^\/api\/admin\/users\/([a-f0-9-]+)\/status$/i);
      if (statusMatch && method === "POST") {
        const targetId = statusMatch[1];
        const body = await request.json().catch(() => null);
        const status = String(body?.status || "");
        if (!["active", "suspended"].includes(status)) return json({ ok: false, error: "Choose active or suspended status." }, 400);
        if (targetId === user.id && status === "suspended") return json({ ok: false, error: "You cannot suspend your own administrator account." }, 400);
        const target = await env.DB.prepare("SELECT id,email,role,status FROM users WHERE id=?").bind(targetId).first();
        if (!target) return json({ ok: false, error: "Member not found." }, 404);
        if (target.role === "admin" && target.status === "active" && status === "suspended") {
          const admins = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND status='active'").first();
          if (Number(admins?.count || 0) <= 1) return json({ ok: false, error: "The last active administrator cannot be suspended." }, 409);
        }
        await env.DB.prepare("UPDATE users SET status=?,updated_at=unixepoch() WHERE id=?").bind(status,targetId).run();
        await env.DB.prepare("INSERT INTO admin_audit_logs (id,actor_id,target_user_id,action,details_json) VALUES (?,?,?,?,?)")
          .bind(crypto.randomUUID(),user.id,targetId,"member_status",JSON.stringify({status,previous_status:target.status})).run();
        return json({ok:true,message:status==="active"?"Member account activated.":"Member account suspended.",status});
      }

      const pointsMatch = path.match(/^\/api\/admin\/users\/([a-f0-9-]+)\/points$/i);
      if (pointsMatch && method === "POST") {
        const targetId = pointsMatch[1];
        const body = await request.json().catch(() => null);
        const delta = Number(body?.delta);
        const description = String(body?.description || "Manual admin adjustment").trim().slice(0,160);
        if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 100000) return json({ok:false,error:"Points adjustment must be a non-zero whole number between -100,000 and 100,000."},400);
        const target = await env.DB.prepare("SELECT id,email FROM users WHERE id=?").bind(targetId).first();
        if (!target) return json({ok:false,error:"Member not found."},404);
        await env.DB.prepare("INSERT OR IGNORE INTO wallets (user_id,balance) VALUES (?,0)").bind(targetId).run();
        const update = await env.DB.prepare("UPDATE wallets SET balance=balance+?,updated_at=unixepoch() WHERE user_id=? AND balance+?>=0")
          .bind(delta,targetId,delta).run();
        if (Number(update.meta?.changes || 0) !== 1) return json({ok:false,error:"Adjustment would make the member's points balance negative."},409);
        const transactionId=crypto.randomUUID();
        const auditDescription=description+" (by "+user.email+")";
        await env.DB.prepare("INSERT INTO point_transactions (id,user_id,amount,type,description,reference_id) VALUES (?,?,?,'adjustment',?,?)")
          .bind(transactionId,targetId,delta,auditDescription,"admin:"+user.id).run();
        await env.DB.prepare("INSERT INTO admin_audit_logs (id,actor_id,target_user_id,action,details_json) VALUES (?,?,?,?,?)")
          .bind(crypto.randomUUID(),user.id,targetId,"points_adjustment",JSON.stringify({delta,description})).run();
        const wallet=await env.DB.prepare("SELECT balance FROM wallets WHERE user_id=?").bind(targetId).first();
        return json({ok:true,message:"Member points updated.",balance:Number(wallet?.balance||0),delta});
      }
      return json({ok:false,error:"Admin endpoint not found."},404);
    }
    if (path === "/api/profile/avatar" && method === "POST") {
      if (!env.MEDIA) return json({ ok: false, error: "Profile image storage is not configured." }, 503);
      const contentType = (request.headers.get("content-type") || "").split(";")[0].toLowerCase();
      const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
      if (!allowedTypes.includes(contentType)) return json({ ok: false, error: "Choose a JPG, PNG, or WebP image." }, 415);
      const bytes = await request.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024) return json({ ok: false, error: "Profile images must be smaller than 2 MB." }, 413);
      const signature = new Uint8Array(bytes.slice(0, 12));
      const valid = contentType === "image/jpeg"
        ? signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff
        : contentType === "image/png"
          ? signature[0] === 0x89 && signature[1] === 0x50 && signature[2] === 0x4e && signature[3] === 0x47
          : signature[0] === 0x52 && signature[1] === 0x49 && signature[2] === 0x46 && signature[3] === 0x46 && signature[8] === 0x57 && signature[9] === 0x45 && signature[10] === 0x42 && signature[11] === 0x50;
      if (!valid) return json({ ok: false, error: "The selected file is not a valid image of that type." }, 415);
      await env.MEDIA.put("avatars/" + user.id + "/profile", bytes, { httpMetadata: { contentType, cacheControl: "private, max-age=3600" } });
      return json({ ok: true, message: "Profile photo updated." });
    }
    if (path === "/api/profile/avatar" && method === "GET") {
      if (!env.MEDIA) return json({ ok: false, error: "Profile image storage is not configured." }, 503);
      const object = await env.MEDIA.get("avatars/" + user.id + "/profile");
      if (!object) return json({ ok: false, error: "No profile photo uploaded." }, 404);
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("cache-control", "private, no-store");
      headers.set("x-content-type-options", "nosniff");
      return new Response(object.body, { headers });
    }
    if (path === "/api/profile/avatar" && method === "DELETE") {
      if (!env.MEDIA) return json({ ok: false, error: "Profile image storage is not configured." }, 503);
      await env.MEDIA.delete("avatars/" + user.id + "/profile");
      return json({ ok: true, message: "Profile photo removed." });
    }

    if (path === "/api/profile/password" && method === "POST") {
      const body = await request.json().catch(() => null);
      const currentPassword = String(body?.current_password || "");
      const newPassword = String(body?.new_password || "");
      if (!currentPassword || newPassword.length < 8 || newPassword.length > 128) {
        return json({ ok: false, error: "Enter your current password and a new password of 8–128 characters." }, 400);
      }
      const account = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(user.id).first();
      if (!account?.password_hash) return json({ ok: false, error: "Password credentials are unavailable for this account." }, 400);
      const parts = account.password_hash.split(":");
      if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return json({ ok: false, error: "Account password format is unsupported." }, 500);
      const verified = await hashPassword(currentPassword, parts[2]);
      if (verified.hash !== parts[3]) return json({ ok: false, error: "Current password is incorrect." }, 401);
      const next = await hashPassword(newPassword);
      const passwordHash = `pbkdf2-sha256:100000:${next.salt}:${next.hash}`;
      await env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = unixepoch() WHERE id = ?").bind(passwordHash, user.id).run();
      const auth = request.headers.get("authorization") || "";
      const currentToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const currentTokenHash = currentToken ? await sha256(currentToken) : "";
      await env.DB.prepare("DELETE FROM user_sessions WHERE user_id = ? AND token_hash != ?").bind(user.id, currentTokenHash).run();
      return json({ ok: true, message: "Password changed. Other sessions have been signed out." });
    }

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
    if(path==="/api/production/schedules"&&method==="GET"){
      const rows=await env.DB.prepare(
        "SELECT s.id,s.topic,s.style,s.duration_seconds,s.platform,s.privacy,s.production_at,s.publish_at,s.review_required,s.status,s.project_id,s.publish_job_id,s.backup_id,s.error_message,s.created_at,s.updated_at,p.title AS project_title,j.status AS publish_status,j.provider_url FROM production_schedules s LEFT JOIN projects p ON p.id=s.project_id LEFT JOIN publish_jobs j ON j.id=s.publish_job_id WHERE s.user_id=? ORDER BY s.production_at DESC LIMIT 60"
      ).bind(user.id).all();
      return json({ok:true,schedules:rows.results||[]});
    }
    if(path==="/api/production/schedules"&&method==="POST"){
      const body=await request.json().catch(()=>null);
      const topic=String(body?.topic||"").trim();
      const style=String(body?.style||"storytelling");
      const duration=Number(body?.duration_seconds||45);
      const platform=String(body?.platform||"youtube");
      const privacy=String(body?.privacy||"private");
      const productionAt=Math.floor(Date.parse(String(body?.production_at||""))/1000);
      const publishAt=Math.floor(Date.parse(String(body?.publish_at||""))/1000);
      const now=Math.floor(Date.now()/1000);
      const styles=["storytelling","anime","educational","toplist","motivation","news"];
      if(topic.length<5||topic.length>2000)return json({ok:false,error:"Topic must be between 5 and 2,000 characters."},400);
      if(!styles.includes(style)||![30,45,60].includes(duration))return json({ok:false,error:"Choose a supported video style and duration."},400);
      if(!["youtube","tiktok"].includes(platform)||!["private","unlisted","public"].includes(privacy))return json({ok:false,error:"Unsupported publishing platform or visibility."},400);
      if(!Number.isFinite(productionAt)||productionAt<=now)return json({ok:false,error:"Choose a future production start time."},400);
      if(!Number.isFinite(publishAt)||publishAt<productionAt)return json({ok:false,error:"The upload time must be the same as or later than production start."},400);
      const connection=await env.DB.prepare("SELECT id FROM social_connections WHERE user_id=? AND platform=? AND status='active' ORDER BY updated_at DESC LIMIT 1").bind(user.id,platform).first();
      if(!connection)return json({ok:false,error:"Connect your "+platform+" account before scheduling production."},409);
      const id=crypto.randomUUID(),reviewRequired=body?.review_required===false?0:1;
      await env.DB.prepare("INSERT INTO production_schedules (id,user_id,connection_id,topic,style,duration_seconds,platform,privacy,production_at,publish_at,review_required,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,'scheduled')")
        .bind(id,user.id,connection.id,topic,style,duration,platform,privacy,productionAt,publishAt,reviewRequired).run();
      try{
        await env.JOBS.send({type:"scheduled_dispatch",kind:"production",schedule_id:id,due_at:productionAt},{delaySeconds:Math.min(72000,Math.max(1,productionAt-now))});
      }catch(error){
        const detail=String(error?.message||error).slice(0,350);
        await env.DB.prepare("UPDATE production_schedules SET status='failed',error_message=?,updated_at=unixepoch() WHERE id=?").bind(detail,id).run();
        return json({ok:false,error:"The schedule was saved but could not be added to the background queue: "+detail},503);
      }
      return json({ok:true,schedule:{id,topic,style,duration_seconds:duration,platform,privacy,production_at:productionAt,publish_at:publishAt,review_required:reviewRequired,status:"scheduled"}},201);
    }
    const productionScheduleMatch=path.match(/^\/api\/production\/schedules\/([a-f0-9-]+)(?:\/(progress|rendered|approve))?$/i);
    if(productionScheduleMatch){
      const id=productionScheduleMatch[1],action=productionScheduleMatch[2]||"";
      if(method==="DELETE"&&!action){
        await env.DB.prepare("UPDATE production_schedules SET status='cancelled',updated_at=unixepoch() WHERE id=? AND user_id=? AND status='scheduled'").bind(id,user.id).run();
        return json({ok:true});
      }
      if(method!=="POST")return json({ok:false,error:"Method not allowed."},405);
      const schedule=await env.DB.prepare("SELECT * FROM production_schedules WHERE id=? AND user_id=?").bind(id,user.id).first();
      if(!schedule)return json({ok:false,error:"Production schedule not found."},404);
      if(action==="progress"){
        const body=await request.json().catch(()=>({})),next=String(body?.status||"");
        if(!["producing","rendering","failed"].includes(next))return json({ok:false,error:"Unsupported production status."},400);
        const detail=String(body?.error||"").slice(0,500)||null;
        const update=await env.DB.prepare("UPDATE production_schedules SET status=?,error_message=?,updated_at=unixepoch() WHERE id=? AND user_id=? AND status IN ('script_queued','producing','rendering')")
          .bind(next,detail,id,user.id).run();
        if(Number(update.meta?.changes||0)!==1)return json({ok:false,error:"This schedule is no longer in an active production state."},409);
        if(schedule.project_id)await env.DB.prepare("UPDATE projects SET status=?,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(next==="failed"?"failed":"processing",schedule.project_id,user.id).run();
        return json({ok:true,status:next});
      }
      if(action==="rendered"){
        if(!["script_queued","producing","rendering"].includes(schedule.status))return json({ok:false,error:"This production is not ready to accept a rendered video."},409);
        const body=await request.json().catch(()=>({})),backupId=String(body?.backup_id||"");
        if(!/^[a-f0-9-]{36}$/i.test(backupId))return json({ok:false,error:"A valid cloud backup ID is required."},400);
        const object=await env.MEDIA.head("users/"+user.id+"/rendered-backups/"+backupId+".mp4");
        if(!object)return json({ok:false,error:"The rendered video is not present in Cloudflare R2."},404);
        const connection=await env.DB.prepare("SELECT id FROM social_connections WHERE id=? AND user_id=? AND status='active'").bind(schedule.connection_id,user.id).first();
        if(!connection)return json({ok:false,error:"The connected publishing account is unavailable. Reconnect it and try again."},409);
        const scriptRow=await env.DB.prepare("SELECT output_json FROM generations WHERE project_id=? AND user_id=? AND stage='script' AND status='completed' ORDER BY created_at DESC LIMIT 1").bind(schedule.project_id,user.id).first();
        if(!scriptRow)return json({ok:false,error:"The completed script could not be found for this production."},409);
        const script=JSON.parse(scriptRow.output_json||"{}");
        const title=String((Array.isArray(script.youtube_title_options)&&script.youtube_title_options[0])||script.title||schedule.topic).trim().slice(0,100);
        const description=String(script.youtube_description||"").trim().slice(0,5000);
        const hashtags=(Array.isArray(script.hashtags)?script.hashtags:[]).map(v=>String(v||"").trim()).filter(Boolean).join(" ").slice(0,1000);
        const tags=(Array.isArray(script.youtube_tags)?script.youtube_tags:[]).map(v=>String(v||"").trim().replace(/^#+/,"")).filter(Boolean).slice(0,30);
        const autoPublish=!Number(schedule.review_required),jobStatus=autoPublish?"queued":"draft";
        const scheduledAt=autoPublish?Number(schedule.publish_at):null,jobId=crypto.randomUUID();
        await env.DB.prepare("INSERT INTO publish_jobs (id,user_id,backup_id,platform,connection_id,title,description,hashtags,tags_json,privacy,scheduled_at,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
          .bind(jobId,user.id,backupId,schedule.platform,connection.id,title,description,hashtags,JSON.stringify(tags),schedule.privacy,scheduledAt,jobStatus).run();
        const nextStatus=autoPublish?"publish_queued":"awaiting_review";
        await env.DB.prepare("UPDATE production_schedules SET backup_id=?,publish_job_id=?,status=?,error_message=NULL,updated_at=unixepoch() WHERE id=? AND user_id=?")
          .bind(backupId,jobId,nextStatus,id,user.id).run();
        await env.DB.prepare("UPDATE projects SET status='completed',updated_at=unixepoch() WHERE id=? AND user_id=?").bind(schedule.project_id,user.id).run();
        if(autoPublish){
          try{await env.JOBS.send({type:"scheduled_dispatch",kind:"publish_job",job_id:jobId,due_at:Number(schedule.publish_at)},{delaySeconds:Math.min(72000,Math.max(1,Number(schedule.publish_at)-Math.floor(Date.now()/1000))) });}
          catch(error){
            const detail=String(error?.message||error).slice(0,350);
            await env.DB.prepare("UPDATE publish_jobs SET status='failed',error_message=?,updated_at=unixepoch() WHERE id=?").bind(detail,jobId).run();
            await env.DB.prepare("UPDATE production_schedules SET status='failed',error_message=?,updated_at=unixepoch() WHERE id=?").bind(detail,id).run();
            return json({ok:false,error:"The video was rendered, but its publishing timer could not be queued: "+detail},503);
          }
        }
        return json({ok:true,status:nextStatus,publish_job_id:jobId,review_required:!autoPublish},201);
      }
      if(action==="approve"){
        if(schedule.status!=="awaiting_review"||!schedule.publish_job_id)return json({ok:false,error:"This production is not waiting for approval."},409);
        await env.DB.prepare("UPDATE publish_jobs SET status='queued',scheduled_at=?,error_message=NULL,updated_at=unixepoch() WHERE id=? AND user_id=? AND status='draft'")
          .bind(schedule.publish_at,schedule.publish_job_id,user.id).run();
        await env.DB.prepare("UPDATE production_schedules SET status='publish_queued',updated_at=unixepoch() WHERE id=? AND user_id=? AND status='awaiting_review'").bind(id,user.id).run();
        try{await env.JOBS.send({type:"scheduled_dispatch",kind:"publish_job",job_id:schedule.publish_job_id,due_at:Number(schedule.publish_at)},{delaySeconds:Math.min(72000,Math.max(1,Number(schedule.publish_at)-Math.floor(Date.now()/1000)))});}
        catch(error){
          const detail=String(error?.message||error).slice(0,350);
          await env.DB.prepare("UPDATE publish_jobs SET status='draft',scheduled_at=NULL,error_message=?,updated_at=unixepoch() WHERE id=?").bind(detail,schedule.publish_job_id).run();
          await env.DB.prepare("UPDATE production_schedules SET status='awaiting_review',error_message=?,updated_at=unixepoch() WHERE id=?").bind(detail,id).run();
          return json({ok:false,error:"Approval was not queued: "+detail},503);
        }
        return json({ok:true,status:"publish_queued",scheduled_at:schedule.publish_at});
      }
      return json({ok:false,error:"Unknown production schedule action."},404);
    }

    if(path==="/api/publishing/youtube/analytics"&&method==="GET"){
      const connection=await env.DB.prepare("SELECT * FROM social_connections WHERE user_id=? AND platform='youtube' AND status='active' ORDER BY updated_at DESC LIMIT 1").bind(user.id).first();
      if(!connection)return json({ok:false,error:"Connect your YouTube channel first."},409);
      const granted=String(connection.scopes||"").split(/\s+/);
      if(!granted.includes("https://www.googleapis.com/auth/yt-analytics.readonly"))return json({ok:false,needs_reconnect:true,error:"Reconnect YouTube to grant read-only YouTube Analytics access."},409);
      const range=String(url.searchParams.get("range")||"28d"),days=({"7d":7,"28d":28,"90d":90,"365d":365})[range]||28;
      const end=new Date(Date.now()-86400000),start=new Date(end.getTime()-(days-1)*86400000),iso=d=>d.toISOString().slice(0,10),startDate=iso(start),endDate=iso(end);
      try{
        const access=await getFreshSocialAccessToken(env,connection);
        const queryReport=async(params)=>{
          const q=new URLSearchParams({ids:"channel==MINE",startDate,endDate,...params});
          const response=await fetch("https://youtubeanalytics.googleapis.com/v2/reports?"+q.toString(),{headers:{authorization:"Bearer "+access},signal:AbortSignal.timeout(18000)});
          const data=await response.json().catch(()=>({}));
          if(!response.ok)throw new Error(data.error?.message||"YouTube Analytics returned HTTP "+response.status);
          const headers=(data.columnHeaders||[]).map(h=>h.name);
          return (data.rows||[]).map(row=>Object.fromEntries(headers.map((name,index)=>[name,row[index]])));
        };
        const metrics="views,likes,comments,shares,subscribersGained";
        const [totals,daily,top]=await Promise.all([queryReport({metrics}),queryReport({metrics,dimensions:"day",sort:"day"}),queryReport({metrics,dimensions:"video",sort:"-views",maxResults:"10"})]);
        const topIds=top.map(v=>String(v.video||"")).filter(Boolean);let titles={};
        if(topIds.length){
          const videoUrl=new URL("https://www.googleapis.com/youtube/v3/videos");videoUrl.searchParams.set("part","snippet");videoUrl.searchParams.set("id",topIds.join(","));
          const videoResponse=await fetch(videoUrl,{headers:{authorization:"Bearer "+access},signal:AbortSignal.timeout(12000)}),videoData=await videoResponse.json().catch(()=>({}));
          if(videoResponse.ok)for(const item of videoData.items||[])titles[item.id]=item.snippet?.title||"Untitled video";
        }
        const sum=totals[0]||{},n=k=>Math.max(0,Number(sum[k]||0)),views=n("views"),likes=n("likes"),comments=n("comments"),shares=n("shares");
        return json({ok:true,source:"youtube_analytics_api",range,start_date:startDate,end_date:endDate,totals:{views,likes,comments,shares,subscribers_gained:n("subscribersGained"),engagement_rate:views?Number(((likes+comments+shares)/views*100).toFixed(2)):0},daily:daily.map(d=>({date:String(d.day||""),views:Number(d.views||0),likes:Number(d.likes||0),comments:Number(d.comments||0),subscribers_gained:Number(d.subscribersGained||0)})),top_videos:top.map(v=>({video_id:String(v.video||""),title:titles[String(v.video||"")]||"YouTube video",views:Number(v.views||0),likes:Number(v.likes||0),comments:Number(v.comments||0),shares:Number(v.shares||0),subscribers_gained:Number(v.subscribersGained||0)})),checked_at:new Date().toISOString()});
      }catch(error){return json({ok:false,error:String(error?.message||error).slice(0,500),range,start_date:startDate,end_date:endDate},502);}
    }
    const connectMatch=path.match(new RegExp("^/api/publishing/connect/(youtube|tiktok)$"));
    if(connectMatch&&method==="POST"){
      const platform=connectMatch[1],now=Math.floor(Date.now()/1000);
      if(platform==="youtube"&&(!env.YOUTUBE_CLIENT_ID||!env.YOUTUBE_CLIENT_SECRET))return json({ok:false,error:"YouTube OAuth credentials are not configured."},503);
      if(platform==="tiktok"&&(!env.TIKTOK_CLIENT_KEY||!env.TIKTOK_CLIENT_SECRET))return json({ok:false,error:"TikTok OAuth credentials are not configured."},503);
      if(!env.PUBLISH_TOKEN_ENCRYPTION_KEY)return json({ok:false,error:"Secure token encryption is not configured."},503);
      const state=randomToken(),redirectUri=new URL(request.url).origin+"/api/publishing/oauth/"+platform+"/callback";
      await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(now).run();
      await env.DB.prepare("INSERT INTO oauth_states (state,user_id,platform,expires_at) VALUES (?,?,?,?)").bind(state,user.id,platform,now+600).run();
      let target;
      if(platform==="youtube"){
        const u=new URL("https://accounts.google.com/o/oauth2/v2/auth");
        u.searchParams.set("client_id",env.YOUTUBE_CLIENT_ID);u.searchParams.set("redirect_uri",redirectUri);u.searchParams.set("response_type","code");u.searchParams.set("scope","https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly");u.searchParams.set("access_type","offline");u.searchParams.set("prompt","consent");u.searchParams.set("state",state);target=u.toString();
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
      const rows=await env.DB.prepare("SELECT j.id,j.backup_id,j.platform,j.title,j.description,j.hashtags,j.tags_json,j.privacy,j.scheduled_at,j.status,j.provider_post_id,j.provider_url,j.error_message,j.created_at,c.display_name AS account_name FROM publish_jobs j LEFT JOIN social_connections c ON c.id=j.connection_id WHERE j.user_id=? ORDER BY j.created_at DESC LIMIT 100").bind(user.id).all();
      return json({ok:true,jobs:rows.results||[]});
    }
    if(path==="/api/publishing/jobs"&&method==="POST"){
      const body=await request.json().catch(()=>null),backupId=String(body?.backup_id||""),platform=String(body?.platform||"");
      const title=String(body?.title||"").trim().slice(0,100),description=String(body?.description||"").trim().slice(0,5000),hashtags=String(body?.hashtags||"").trim().slice(0,1000);
      const rawTags=platform==="youtube"?(Array.isArray(body?.tags)?body.tags:(typeof body?.tags==="string"?body.tags.split(/[,;\n]+/):[])):[];
      const tags=[],seenTags=new Set();let tagBytes=0;
      for(const value of rawTags){
        if(typeof value!=="string")return json({ok:false,error:"Each YouTube tag must be text."},400);
        const tag=value.trim().replace(/^#+/,"").replace(/\s+/g," ");
        if(!tag)continue;
        const key=tag.toLocaleLowerCase();if(seenTags.has(key))continue;
        const cost=encoder.encode(tag).byteLength+(tags.length?1:0);
        if(tags.length>=30)return json({ok:false,error:"YouTube allows up to 30 tags per video."},400);
        if(tagBytes+cost>500)return json({ok:false,error:"Combined YouTube tags must be 500 characters or fewer."},400);
        seenTags.add(key);tags.push(tag);tagBytes+=cost;
      }
      if(!/^[a-f0-9-]{36}$/i.test(backupId)||!["youtube","tiktok"].includes(platform)||!title)return json({ok:false,error:"Choose a cloud video, platform, and title."},400);
      const connection=await env.DB.prepare("SELECT id FROM social_connections WHERE user_id=? AND platform=? AND status='active' ORDER BY updated_at DESC LIMIT 1").bind(user.id,platform).first();
      if(!connection)return json({ok:false,error:"Connect your "+platform+" account before preparing a post."},409);
      const key="users/"+user.id+"/rendered-backups/"+backupId+".mp4",object=await env.MEDIA.head(key);
      if(!object)return json({ok:false,error:"Cloud video not found. Upload or render a video backup first."},404);
      const id=crypto.randomUUID();
      const scheduledAtRaw=body?.scheduled_at;
      const scheduledAt=scheduledAtRaw?Math.floor(new Date(scheduledAtRaw).getTime()/1000):null;
      if(scheduledAtRaw&&(!Number.isFinite(scheduledAt)||scheduledAt<=Math.floor(Date.now()/1000)))return json({ok:false,error:"Choose a future date and time for scheduled publishing."},400);
      const initialStatus=scheduledAt?"queued":"draft";
      await env.DB.prepare("INSERT INTO publish_jobs (id,user_id,backup_id,platform,connection_id,title,description,hashtags,tags_json,privacy,scheduled_at,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,user.id,backupId,platform,connection.id,title,description,hashtags,JSON.stringify(tags),String(body?.privacy||"private"),scheduledAt,initialStatus).run();
      if(scheduledAt){
        try{await env.JOBS.send({type:"scheduled_dispatch",kind:"publish_job",job_id:id,due_at:scheduledAt},{delaySeconds:Math.min(72000,Math.max(1,scheduledAt-Math.floor(Date.now()/1000)))});}
        catch(error){
          const detail=String(error?.message||error).slice(0,350);
          await env.DB.prepare("UPDATE publish_jobs SET status='failed',scheduled_at=NULL,error_message=?,updated_at=unixepoch() WHERE id=?").bind(detail,id).run();
          return json({ok:false,error:"The post was saved but its upload timer could not be queued: "+detail},503);
        }
        return json({ok:true,job:{id,backup_id:backupId,platform,title,status:initialStatus,scheduled_at:scheduledAt}},201);
      }
      return json({ok:true,job:{id,backup_id:backupId,platform,title,status:initialStatus}},201);
    }
    const youtubeStatusMatch=path.match(new RegExp("^/api/publishing/jobs/([a-f0-9-]+)/refresh-status$","i"));
    if(youtubeStatusMatch&&method==="POST"){
      const id=youtubeStatusMatch[1],job=await env.DB.prepare("SELECT id,status,platform,provider_post_id FROM publish_jobs WHERE id=? AND user_id=?").bind(id,user.id).first();
      if(!job)return json({ok:false,error:"Publishing job not found."},404);
      if(job.platform!=="youtube"||job.status!=="processing"||!job.provider_post_id)return json({ok:false,error:"Only an uploaded YouTube video can be checked again."},409);
      if(!env.JOBS||typeof env.JOBS.send!=="function")return json({ok:false,error:"Publishing queue is unavailable."},503);
      await env.JOBS.send({type:"check_youtube_status",job_id:id,attempt:1});
      await env.DB.prepare("UPDATE publish_jobs SET error_message=NULL,updated_at=unixepoch() WHERE id=?").bind(id).run();
      return json({ok:true,status:"processing",message:"YouTube processing status check queued."},202);
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
      if(!env.AI||typeof env.AI.run!=="function")return json({ok:false,error:"Cloudflare Workers AI binding is unavailable."},503);
      const scriptRow=await env.DB.prepare("SELECT id,output_json FROM generations WHERE project_id=? AND user_id=? AND stage='script' AND status='completed' ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id).first();
      if(!scriptRow)return json({ok:false,error:"Generate a script before creating the voice-over."},409);
      const script=JSON.parse(scriptRow.output_json),narration=String(script.narration||(script.scenes||[]).map(s=>s.voiceover||"").join(" ")).trim();
      if(!narration)return json({ok:false,error:"The saved script has no narration text."},422);
      if(narration.length>2000)return json({ok:false,error:"Narration is too long for one Aura-2 request (maximum 2,000 characters). Shorten the script and try again."},413);
      const pending=await env.DB.prepare("SELECT id,status FROM generations WHERE project_id=? AND user_id=? AND stage='voice' AND json_extract(input_json,'$.script_generation_id')=? AND status IN ('queued','processing') ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id,scriptRow.id).first();
      if(pending)return json({ok:true,queued:true,generation_id:pending.id,status:pending.status},202);
      const generationId=crypto.randomUUID(),model="@cf/deepgram/aura-1",provider="cloudflare-workers-ai";
      const input={provider,model,language:"en",script_generation_id:scriptRow.id,characters:narration.length,voice:"luna",billing_note:"Cloudflare Workers AI Aura-1: 1,363.64 Neurons per 1,000 input characters; included Workers AI daily free allocation applies."};
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
        const result=await runTrackedAI(env,{user_id:user.id,project_id:projectId,generation_id:generationId,stage:"character_reference",input_characters:prompt.length},"@cf/black-forest-labs/flux-1-schnell",{prompt,steps:4});
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
        return json({ok:false,error:message},error?.code==="AI_DAILY_LIMIT_REACHED"||/limit|quota|billing|exceeded/i.test(message)?429:502);
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
            const result=await runTrackedAI(env,{user_id:user.id,project_id:projectId,generation_id:generationId,stage:"visuals",input_characters:continuityPrompt.length,input_bytes:referenceBytes.byteLength},"@cf/runwayml/stable-diffusion-v1-5-img2img",{
              prompt:continuityPrompt,
              image:Array.from(referenceBytes),strength,guidance:7.5,num_steps:20,width:768,height:1344,
              negative_prompt:"different character, changed face, changed hairstyle, changed outfit, inconsistent art style, duplicate people, collage, split screen, text, watermark"
            });
            bytes=await readImageResult(result);
          }catch(referenceError){
            continuityFallback=String(referenceError.message||referenceError).slice(0,240);
            const fallbackResult=await runTrackedAI(env,{user_id:user.id,project_id:projectId,generation_id:generationId,stage:"visuals",input_characters:prompt.length},"@cf/black-forest-labs/flux-1-schnell",{prompt,steps:4});
            bytes=await readImageResult(fallbackResult);actualModel="@cf/black-forest-labs/flux-1-schnell";continuityMode="text-fallback";
          }
        }else{const result=await runTrackedAI(env,{user_id:user.id,project_id:projectId,generation_id:generationId,stage:"visuals",input_characters:prompt.length},"@cf/black-forest-labs/flux-1-schnell",{prompt,steps:4});bytes=await readImageResult(result);}
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
        return json({ok:false,error:message},error?.code==="AI_DAILY_LIMIT_REACHED"||/limit|quota|billing|exceeded/i.test(message)?429:502);
      }
    }

    const subtitlesMatch = path.match(/^\/api\/projects\/([a-f0-9-]+)\/subtitles$/i);
    if (subtitlesMatch && (method === "GET" || method === "POST" || method === "PUT")) {
      const projectId = subtitlesMatch[1];
      const project = await env.DB.prepare("SELECT id, duration_seconds FROM projects WHERE id = ? AND user_id = ?").bind(projectId, user.id).first();
      if (!project) return json({ ok: false, error: "Project not found." }, 404);
      if (method === "PUT") {
        const saved = await env.DB.prepare("SELECT id, output_json FROM generations WHERE project_id = ? AND user_id = ? AND stage = 'subtitles' AND status = 'completed' AND json_array_length(json_extract(output_json, '$.cues')) > 0 ORDER BY created_at DESC LIMIT 1").bind(projectId, user.id).first();
        if (!saved) return json({ ok: false, error: "Generate subtitles before editing caption text or timing." }, 409);
        let subtitleData;
        try { subtitleData = JSON.parse(saved.output_json || "{}"); } catch { subtitleData = {}; }
        const body = await request.json().catch(() => null);
        if (!Array.isArray(body?.cues) || body.cues.length < 1 || body.cues.length > 500) {
          return json({ ok: false, error: "Submit between 1 and 500 caption lines." }, 400);
        }
        const duration = Number(subtitleData.duration_seconds) || Math.max(...(subtitleData.cues || []).map(cue => Number(cue.end) || 0));
        if (!Number.isFinite(duration) || duration <= 0) return json({ ok: false, error: "The saved subtitle duration is invalid. Regenerate subtitles." }, 409);
        const existingCues = Array.isArray(subtitleData.cues) ? subtitleData.cues : [];
        let cues = [];
        let previousStart = -1;
        for (let index = 0; index < body.cues.length; index++) {
          const item = body.cues[index] || {};
          if (item.start === null || item.end === null || item.start === "" || item.end === "") {
            return json({ ok: false, error: "Caption " + (index + 1) + " needs both start and end times." }, 400);
          }
          const start = Number(item.start), end = Number(item.end);
          const text = String(item.text || "").replace(/\s+/g, " ").trim();
          if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < 0.08 || end > duration + 0.25) {
            return json({ ok: false, error: "Caption " + (index + 1) + " has invalid timing. Keep it within the " + duration.toFixed(2) + " second audio duration." }, 400);
          }
          if (start < previousStart) return json({ ok: false, error: "Caption start times must stay in chronological order." }, 400);
          if (!text || text.length > 180) return json({ ok: false, error: "Caption " + (index + 1) + " must contain 1–180 characters." }, 400);
          previousStart = start;
          const previousCue = existingCues[index] || {};
          const textId = String(item.text_id ?? previousCue.text_id ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
          cues.push({
            index: index + 1,
            start: Number(start.toFixed(3)),
            end: Number(end.toFixed(3)),
            text,
            ...(textId ? { text_id: textId } : {})
          });
        }
        subtitleData.cues = cues;
        subtitleData.languages = cues.some(cue => cue.text_id) ? ["en", "id"] : ["en"];
        subtitleData.edited_at = new Date().toISOString();
        subtitleData.edit_source = "user";
        await env.DB.prepare("UPDATE generations SET output_json = ?, updated_at = unixepoch() WHERE id = ? AND project_id = ? AND user_id = ? AND stage = 'subtitles' AND status = 'completed'")
          .bind(JSON.stringify(subtitleData), saved.id, projectId, user.id).run();
        return json({ ok: true, subtitles: subtitleData, generation_id: saved.id });
      }
      if (method === "GET") {
        const saved = await env.DB.prepare("SELECT id, output_json, created_at FROM generations WHERE project_id = ? AND user_id = ? AND stage = 'subtitles' AND status = 'completed' AND json_array_length(json_extract(output_json, '$.cues')) > 0 ORDER BY created_at DESC LIMIT 1").bind(projectId, user.id).first();
        return json({ ok: true, subtitles: saved ? JSON.parse(saved.output_json) : null, generation_id: saved?.id || null });
      }
      if (method === "POST") {
        const body = await request.json().catch(() => null);
        if (body?.action === "translate") {
          const saved = await env.DB.prepare("SELECT id, output_json FROM generations WHERE project_id = ? AND user_id = ? AND stage = 'subtitles' AND status = 'completed' AND json_array_length(json_extract(output_json, '$.cues')) > 0 ORDER BY created_at DESC LIMIT 1").bind(projectId, user.id).first();
          if (!saved) return json({ ok: false, error: "Generate English subtitles before translating them." }, 409);
          let subtitleData = {};
          try { subtitleData = JSON.parse(saved.output_json || "{}"); } catch {}
          if (!Array.isArray(subtitleData.cues) || !subtitleData.cues.length) return json({ ok: false, error: "No English subtitle cues are available to translate." }, 409);
          try {
            const translated = await translateSubtitleCues(env, subtitleData.cues);
            subtitleData.cues = translated.cues;
            subtitleData.languages = ["en", "id"];
            subtitleData.translation = {
              status: "complete",
              language: "id",
              language_name: "Bahasa Indonesia",
              provider: translated.provider,
              model: translated.model,
              updated_at: new Date().toISOString()
            };
            subtitleData.edited_at = new Date().toISOString();
            await env.DB.prepare("UPDATE generations SET output_json = ?, updated_at = unixepoch() WHERE id = ? AND project_id = ? AND user_id = ? AND stage = 'subtitles' AND status = 'completed'")
              .bind(JSON.stringify(subtitleData), saved.id, projectId, user.id).run();
            return json({ ok: true, subtitles: subtitleData, generation_id: saved.id });
          } catch (error) {
            return json({ ok: false, error: String(error?.message || error).slice(0, 420) }, 502);
          }
        }
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
        const rawResult = await runTrackedAI(env,{user_id:user.id,project_id:projectId,generation_id:generationId,stage:"subtitles",input_bytes:audioBytes.byteLength},"@cf/openai/whisper",{ audio: Array.from(audioBytes) });
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
            const tokens = sentence.trim().split(/\s+/).filter(Boolean);
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
        if (!cues.length) throw new Error("Whisper returned a transcript, but no usable subtitle phrases could be built from the saved script. Check the project narration and regenerate the script if it is empty.");
        let subtitleTranslation = { cues, provider: null, model: null, error: null };
        try {
          subtitleTranslation = await translateSubtitleCues(env, cues);
          cues = subtitleTranslation.cues;
        } catch (translationError) {
          subtitleTranslation.error = String(translationError?.message || translationError).slice(0, 360);
          console.warn(JSON.stringify({
            event: "subtitle_translation_pending",
            project_id: projectId,
            generation_id: generationId,
            error: subtitleTranslation.error
          }));
        }
        const duration = Number(Math.max(...cues.map(cue => cue.end)).toFixed(3));
        if (!Number.isFinite(duration) || duration <= 0) throw new Error("Subtitle timing is invalid. Regenerate the voice-over and try again.");
        const bilingualReady = cues.length > 0 && cues.every(cue => String(cue.text_id || "").trim());
        const subtitleData = { format: "webvtt", timing: timingMode, source: subtitleSource, model: "@cf/openai/whisper", languages: bilingualReady ? ["en", "id"] : ["en"], translation: { status: bilingualReady ? "complete" : "pending", language: "id", language_name: "Bahasa Indonesia", provider: subtitleTranslation.provider, model: subtitleTranslation.model, error: subtitleTranslation.error || null }, duration_seconds: duration, word_count: words.length || Number(transcription.word_count) || 0, transcript: whisperTranscript.slice(0, 12000), script_match_score: Number(matchScore.toFixed(3)), quality_check: matchScore < 0.72 ? "low-whisper-match-script-fallback-used" : "whisper-transcript-accepted", cues };
        await env.DB.prepare("UPDATE generations SET status='completed', input_json=?, output_json=?, updated_at=unixepoch() WHERE id=? AND user_id=?").bind(JSON.stringify({ source: "saved voice-over audio", timing: timingMode, model: "@cf/openai/whisper", audio_bytes: audioBytes.byteLength, script_match_score: Number(matchScore.toFixed(3)), subtitle_source: subtitleSource, translation_provider: subtitleTranslation.provider, translation_model: subtitleTranslation.model, translation_status: bilingualReady ? "complete" : "pending", languages: bilingualReady ? ["en", "id"] : ["en"] }), JSON.stringify(subtitleData), generationId, user.id).run();
        return json({ ok: true, subtitles: subtitleData, generation_id: generationId }, 201);
      } catch (error) {
        await env.DB.prepare("UPDATE generations SET status='failed', error_message=?, updated_at=unixepoch() WHERE id=? AND user_id=?").bind(String(error.message || error).slice(0, 500), generationId, user.id).run();
        const message = String(error.message || "Speech recognition failed.");
        return json({ ok: false, error: message }, error?.code==="AI_DAILY_LIMIT_REACHED"||/limit|quota|billing|credit|exceeded/i.test(message) ? 429 : 502);
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

async function createProductionProjectForSchedule(env,schedule){
  const now=Math.floor(Date.now()/1000),projectId=crypto.randomUUID(),generationId=crypto.randomUUID();
  try{
    const title=String(schedule.topic||"Untitled video").slice(0,72);
    await env.DB.prepare("INSERT INTO projects (id,user_id,title,topic,status,aspect_ratio,language,duration_seconds,style) VALUES (?,?,?,?,'queued','9:16','en',?,?)")
      .bind(projectId,schedule.user_id,title,schedule.topic,schedule.duration_seconds,schedule.style).run();
    const input={topic:schedule.topic,language:"en",duration_seconds:schedule.duration_seconds,style:schedule.style,scheduled_production_id:schedule.id,queued_at:new Date().toISOString()};
    await env.DB.prepare("INSERT INTO generations (id,project_id,user_id,stage,status,input_json) VALUES (?,?,?,'script','queued',?)")
      .bind(generationId,projectId,schedule.user_id,JSON.stringify(input)).run();
    await env.DB.prepare("UPDATE production_schedules SET project_id=?,status='script_queued',error_message=NULL,updated_at=? WHERE id=? AND status='starting'")
      .bind(projectId,now,schedule.id).run();
    await env.JOBS.send({type:"generate_script",generation_id:generationId,project_id:projectId,user_id:schedule.user_id});
    return {ok:true,project_id:projectId,generation_id:generationId};
  }catch(error){
    const detail=String(error?.message||error).slice(0,500);
    await env.DB.prepare("UPDATE production_schedules SET status='failed',error_message=?,updated_at=? WHERE id=? AND status IN ('starting','script_queued')").bind(detail,now,schedule.id).run();
    await env.DB.prepare("UPDATE projects SET status='failed',updated_at=? WHERE id=?").bind(now,projectId).run().catch(()=>{});
    await env.DB.prepare("UPDATE generations SET status='failed',error_message=?,updated_at=? WHERE id=?").bind(detail,now,generationId).run().catch(()=>{});
    throw error;
  }
}

async function processScheduledDispatchMessage(message,env){
  const body=message.body||{},dueAt=Math.floor(Number(body.due_at)||0),now=Math.floor(Date.now()/1000);
  if(!["production","publish_job"].includes(body.kind)||!dueAt){message.ack();return;}
  if(dueAt>now){
    try{
      await env.JOBS.send(body,{delaySeconds:Math.min(72000,Math.max(1,dueAt-now))});
      message.ack();
    }catch(error){
      console.error(JSON.stringify({event:"scheduled_dispatch_reschedule_failed",kind:body.kind,error:String(error?.message||error).slice(0,240)}));
      message.retry({delaySeconds:30});
    }
    return;
  }
  if(body.kind==="production"){
    const schedule=await env.DB.prepare("SELECT * FROM production_schedules WHERE id=? AND status='scheduled'").bind(String(body.schedule_id||"")).first();
    if(!schedule){message.ack();return;}
    const claim=await env.DB.prepare("UPDATE production_schedules SET status='starting',updated_at=? WHERE id=? AND status='scheduled' AND production_at<=?")
      .bind(now,schedule.id,now).run();
    if(Number(claim.meta?.changes||0)!==1){message.ack();return;}
    try{await createProductionProjectForSchedule(env,schedule);message.ack();}
    catch(error){
      console.error(JSON.stringify({event:"scheduled_production_start_failed",schedule_id:schedule.id,error:String(error?.message||error).slice(0,400)}));
      message.ack();
    }
    return;
  }
  const jobId=String(body.job_id||"");
  const job=await env.DB.prepare("SELECT id,status,scheduled_at FROM publish_jobs WHERE id=?").bind(jobId).first();
  if(!job||job.status!=="queued"||!job.scheduled_at){message.ack();return;}
  const claim=await env.DB.prepare("UPDATE publish_jobs SET scheduled_at=NULL,updated_at=? WHERE id=? AND status='queued' AND scheduled_at<=?")
    .bind(now,jobId,now).run();
  if(Number(claim.meta?.changes||0)!==1){message.ack();return;}
  try{
    await env.JOBS.send({type:"publish_video",job_id:jobId});
    message.ack();
  }catch(error){
    await env.DB.prepare("UPDATE publish_jobs SET scheduled_at=?,error_message=?,updated_at=? WHERE id=? AND status='queued'")
      .bind(job.scheduled_at,String(error?.message||error).slice(0,350),now,jobId).run();
    message.retry({delaySeconds:30});
  }
}

async function runScheduledMaintenance(env, scheduledTime) {
  const now = Math.floor(Date.now() / 1000);
  const staleBefore = now - 30 * 60;

  // Recover jobs abandoned by an isolate termination or provider timeout.
  // They become visibly failed so the user can safely retry them.
  const staleJobs = await env.DB.prepare(
    "UPDATE generations SET status='failed', error_message=COALESCE(error_message, 'Job timed out before completion. Please retry this step.'), updated_at=? WHERE status='processing' AND updated_at < ?"
  ).bind(now, staleBefore).run();

  // Dispatch scheduled publishing jobs once their timestamp is due.
  const dueJobs = await env.DB.prepare(
    "SELECT id FROM publish_jobs WHERE status='queued' AND scheduled_at IS NOT NULL AND scheduled_at<=? ORDER BY scheduled_at ASC LIMIT 10"
  ).bind(now).all();
  let dispatchedSchedules=0;
  for(const job of dueJobs.results||[]){
    const claim=await env.DB.prepare(
      "UPDATE publish_jobs SET scheduled_at=NULL,updated_at=? WHERE id=? AND status='queued' AND scheduled_at IS NOT NULL AND scheduled_at<=?"
    ).bind(now,job.id,now).run();
    if(Number(claim.meta?.changes||0)!==1)continue;
    try{
      await env.JOBS.send({type:"publish_video",job_id:job.id});
      dispatchedSchedules++;
    }catch(error){
      await env.DB.prepare("UPDATE publish_jobs SET scheduled_at=?,error_message=?,updated_at=? WHERE id=? AND status='queued'")
        .bind(now+60,String(error?.message||error).slice(0,400),now,job.id).run();
    }
  }

  // Remove expired session hashes; active sessions are unaffected.
  const expiredSessions = await env.DB.prepare(
    "DELETE FROM user_sessions WHERE expires_at <= ?"
  ).bind(now).run();

  console.log(JSON.stringify({
    event: "scheduled_maintenance_completed",
    scheduled_at: new Date(scheduledTime || now * 1000).toISOString(),
    stale_jobs_recovered: Number(staleJobs.meta?.changes || 0),
    expired_sessions_removed: Number(expiredSessions.meta?.changes || 0),
    scheduled_publish_jobs_dispatched: dispatchedSchedules,
  }));
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages) { if(message.body?.type==="scheduled_dispatch") await processScheduledDispatchMessage(message,env); else if (message.body?.type === "generate_voice") await processVoiceQueueMessage(message, env); else if(message.body?.type === "publish_video") await processPublishQueueMessage(message,env); else if(message.body?.type === "check_tiktok_status") await processTikTokStatusMessage(message,env); else if(message.body?.type === "check_youtube_status") await processYouTubeStatusMessage(message,env); else await processScriptQueueMessage(message, env); }
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
    const appOrigin = env.APP_ORIGIN || "https://facelesslab.pages.dev";
    const previewOriginAllowed = /^https:\/\/[a-z0-9-]+\.facelesslab\.pages\.dev$/i.test(origin || "");
    const originAllowed = !origin || origin === appOrigin || previewOriginAllowed;
    const headers = {
      ...(origin && originAllowed ? { "access-control-allow-origin": origin } : {}),
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
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
