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
    { role: "system", content: "You are an expert YouTube storyteller, documentary writer, audience-retention editor, and metadata strategist. Write vivid, natural, original spoken English with varied vocabulary and sentence rhythm. Avoid repetitive wording, generic AI phrases, filler, fake suspense, and unsupported claims. Optimize for viewer satisfaction and honest discoverability. Return one valid JSON object only; no markdown fences or commentary." },
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
    `Return exactly one valid JSON object with this schema: {"title":"string","hook":"string","narration":"string","scenes":[{"scene":"number","duration_seconds":"number","voiceover":"string","visual_prompt":"string","on_screen_text":"string","transition":"string"}],"closing":"string","cta":"string","estimated_duration_seconds":"number","series_summary":"string","character_bible":"string","ending_state":"string","youtube_title_options":["string","string","string"],"youtube_description":"string","youtube_tags":["string"],"hashtags":["string"],"thumbnail_text":"string","pinned_comment":"string"}.`,
    "Narration must contain " + minWords + " to " + maxWords + " spoken words (aim for " + targetWords + "). Keep it natural and avoid padding.",
    "VOCABULARY: Use broad, precise, varied vocabulary suited to the topic. Mix short punchy lines with longer flowing sentences. Prefer concrete verbs, specific nouns, sensory detail, fresh comparisons and conversational phrasing. Vary sentence openings, transitions and sentence rhythm. Avoid thesaurus stuffing, cliches, filler, repeated adjectives, repeated rhetorical questions and robotic phrases such as Imagine this, In this video, Let us dive in. Every sentence must add a fact, image, emotion or forward movement.",
    "RETENTION: Open with a concrete curiosity gap or striking detail in the first sentence. Establish why viewers should care immediately. Build a clear progression with escalating discoveries, meaningful stakes, pattern interrupts and satisfying payoffs. Do not reveal the full payoff in the opening. Avoid fake cliffhangers, empty hype and repetitive summaries. End with a memorable takeaway and a brief natural CTA.",
    "FACTUAL INTEGRITY: Never invent statistics, quotations, studies, dates, named sources or historical details. Phrase uncertainty cautiously. Do not present speculation as fact. Titles must be compelling but truthful, not deceptive clickbait.",
    "YOUTUBE PUBLISHING PACK: Provide 3 distinct concise title options. Write a useful description with a strong first 2 lines, concise summary, relevant context and natural CTA; no keyword stuffing. Provide 8–15 relevant search tags as plain phrases without #, 3–5 relevant hashtags with #, thumbnail_text of 2–5 punchy mobile-readable words that does not simply repeat the title, and a pinned_comment that invites a genuine response.",
    "Create 5 to 7 scenes covering the full target duration. Scene voiceovers must divide the narration in order, preserve its exact sequence, and collectively cover the whole narration.",
    "STORYBOARD RULES: Every scene must depict the exact event, person, place, object, or action being described by that scene's voiceover. Build a logical beginning-middle-ending sequence. Each scene must be a new visual moment and materially different from the previous scene; never reuse the same image idea, pose, camera angle, or setting just to fill time.",
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
  const script=JSON.parse(scriptRow.output_json),narration=String(script.narration||(script.scenes||[]).map(s=>s.voiceover||"").join(" ")).trim();
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
  const output={object_key:objectKey,mime_type:"audio/mpeg",bytes:audio.byteLength,provider,model,language:"en",characters:narration.length};
  await env.DB.prepare("UPDATE generations SET status='completed',output_json=?,error_message=NULL,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(JSON.stringify(output),generationId,userId).run();
  console.log(JSON.stringify({event:"background_voice_completed",generation_id:generationId,project_id:projectId}));message.ack();
 }catch(error){
  const detail=String(error?.message||error).slice(0,500),attempts=Number(message.attempts||1);
  console.error(JSON.stringify({event:"background_voice_attempt_failed",generation_id:generationId,attempts,error:detail}));
  if(attempts>=3){await env.DB.prepare("UPDATE generations SET status='failed',error_message=?,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(detail,generationId,userId).run();message.ack();}
  else message.retry({delaySeconds:Math.min(60,attempts*15)});
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
      version: "0.8.0",
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

  if (path.startsWith("/api/")) {
    const user = await getUser(request, env);
    if (!user) return json({ ok: false, error: "Authentication required." }, 401);
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
        "EXACT MOMENT TO ILLUSTRATE: "+clean(scene.voiceover,240),
        "DIRECTOR'S VISUAL BRIEF: "+clean(visualPrompt,480),
        "SHOT DESIGN: "+shotDirection,
        "COMPOSITION: One instantly readable focal subject. Strong foreground, middle-ground and background separation. Intentional negative space. Subject placement and silhouette must read clearly on a phone screen. Show the described action at its most visually informative instant.",
        "CAMERA AND LIGHT: Use a deliberate cinematic camera distance and angle, natural perspective, controlled depth of field, motivated key light, subtle rim light where appropriate, and a coherent color grade. Avoid flat centered passport-like framing.",
        animeMode
          ? "Maintain the same anime character identity, face shape, eye design, hairstyle, colors and outfit. Keep linework, cel shading and background painting consistent."
          : "Maintain recurring character identity, age appearance, wardrobe, era, location logic, lens language and color grade. Keep anatomy, hands, objects and architecture plausible.",
        previousScene?"PREVIOUS BEAT (continuity only): "+clean(previousScene.voiceover,90)+". Advance the story; do not repeat its action, pose or composition.":"OPENING BEAT: establish the story world with a strong visual question.",
        continuation&&sceneIndex===0?"SERIES CONTINUATION: Start from the previous episode's exact ending state. Previous action: "+clean(continuation.ending_state||continuation.previous_ending_voiceover,180)+". Previous shot: "+clean(continuation.previous_ending_visual_prompt,220)+". Preserve identity and world continuity.":"",
        nextScene?"NEXT BEAT (context only): "+clean(nextScene.voiceover,90)+". Foreshadow subtly without depicting a later event.":"FINAL BEAT: deliver a clear visual payoff that supports the narration.",
        "STRICT: one location, one camera frame, one primary action and one instant in time. Do not depict events absent from the narration. No collage, montage, grid, split screen, panels, poster, infographic, UI, text, captions, subtitles, logos, borders or watermark. Avoid generic stock-photo posing, repeated compositions, extra limbs, malformed hands, duplicate subjects and visual clutter."
      ].filter(Boolean).join(" ").slice(0,2600);
      let referenceObjectKey=null,referenceSource=null;
      if(sceneIndex>0){
        for(let index=sceneIndex-1;index>=0;index--){
          const priorSceneNumber=Number(scenes[index].scene);
          const priorRow=await env.DB.prepare("SELECT output_json FROM generations WHERE project_id=? AND user_id=? AND stage='visuals' AND status='completed' AND json_extract(output_json,'$.scene_number')=? ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id,priorSceneNumber).first();
          if(priorRow){try{const priorMeta=JSON.parse(priorRow.output_json||"{}");if(priorMeta.object_key){referenceObjectKey=priorMeta.object_key;referenceSource="previous_scene_"+priorSceneNumber;break;}}catch{}}
        }
      }
      if(!referenceObjectKey&&sceneIndex===0&&continuation?.reference_image_object_key){referenceObjectKey=continuation.reference_image_object_key;referenceSource="previous_episode_ending";}
      const generationId=crypto.randomUUID();
      const preferredModel=referenceObjectKey?"@cf/runwayml/stable-diffusion-v1-5-img2img":"@cf/black-forest-labs/flux-1-schnell";
      await env.DB.prepare("INSERT INTO generations (id,project_id,user_id,stage,status,input_json) VALUES (?,?,?,'visuals','processing',?)").bind(generationId,projectId,user.id,JSON.stringify({model:preferredModel,scene_number:sceneNumber,prompt,reference_object_key:referenceObjectKey,reference_source:referenceSource})).run();
      try{
        let bytes=null,actualModel=preferredModel,continuityMode=referenceObjectKey?"image-to-image":"text-to-image",continuityFallback=null;
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
            const strength=referenceSource==="previous_episode_ending"?0.48:0.62;
            const result=await env.AI.run("@cf/runwayml/stable-diffusion-v1-5-img2img",{
              prompt:prompt+" Use the reference image to preserve the exact character identity, face, hairstyle, clothing, art direction and color palette. Change the pose, camera framing and background action only as required by this scene. Do not copy the previous scene composition when the new scene describes a different action.",
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
        const output={object_key:objectKey,mime_type:"image/png",bytes:bytes.byteLength,provider:"cloudflare-workers-ai",model:actualModel,scene_number:sceneNumber,prompt,continuity_mode:continuityMode,reference_source:referenceSource,reference_object_key:referenceObjectKey,continuity_fallback_error:continuityFallback};
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
      const scriptRow = await env.DB.prepare("SELECT id FROM generations WHERE project_id = ? AND user_id = ? AND stage = 'script' AND status = 'completed' ORDER BY created_at DESC LIMIT 1").bind(projectId, user.id).first();
      if (!scriptRow) return json({ ok: false, error: "Generate a script before creating subtitles." }, 409);
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
          let group = [];
          const flush = () => {
            if (!group.length) return;
            const start = Math.max(0, group[0].start - 0.025);
            const end = Math.max(start + 0.12, group[group.length - 1].end + 0.045);
            cues.push({ index: cues.length + 1, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)), text: group.map(item => item.word).join(" ").replace(/\s+([,.;!?])/g, "$1") });
            group = [];
          };
          for (const item of words) {
            const candidate = group.concat(item);
            const candidateText = candidate.map(word => word.word).join(" ");
            const endsSentence = /[.!?]["')\]]?$/.test(item.word);
            if (group.length && (candidate.length > 6 || candidateText.length > 42 || (endsSentence && candidate.length >= 3))) flush();
            group.push(item);
            if (/[.!?]["')\]]?$/.test(item.word) && group.length >= 3) flush();
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
        const duration = Number(Math.max(...cues.map(cue => cue.end)).toFixed(3));
        const subtitleData = { format: "webvtt", timing: "audio-aligned", source: "voice-over-audio", model: "@cf/openai/whisper", duration_seconds: duration, word_count: words.length || Number(transcription.word_count) || 0, transcript: String(transcription.text || "").slice(0, 12000), cues };
        await env.DB.prepare("UPDATE generations SET status='completed', input_json=?, output_json=?, updated_at=unixepoch() WHERE id=? AND user_id=?").bind(JSON.stringify({ source: "saved voice-over audio", timing: "audio-aligned", model: "@cf/openai/whisper", audio_bytes: audioBytes.byteLength }), JSON.stringify(subtitleData), generationId, user.id).run();
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
      let endingVisual = null, endingVisualSceneNumber = null;
      for (const row of (visualRows.results||[])) {
        try { const meta=JSON.parse(row.output_json||"{}"); if(!endingVisual && meta.object_key) { endingVisual=meta; endingVisualSceneNumber=Number(meta.scene_number)||null; } if(Number(meta.scene_number)===Number(lastScene.scene) && meta.object_key) { endingVisual=meta; endingVisualSceneNumber=Number(meta.scene_number)||null; break; } } catch {}
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
        reference_scene_number:endingVisualSceneNumber,
        visual_reference_available:Boolean(endingVisual?.object_key), style:parent.style, language:"en"
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
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
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
