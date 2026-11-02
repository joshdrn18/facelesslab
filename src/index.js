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
  const response = await fetch(baseUrl + "/chat/completions", {
    method: "POST",
    headers: {
      "authorization": "Bearer " + provider.apiKey,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: provider.model || "gpt-4o-mini",
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a professional short-form video scriptwriter. Return valid JSON only. No markdown fences." },
        { role: "user", content: prompt }
      ]
    }),
    signal: AbortSignal.timeout(55000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || ("AI provider returned HTTP " + response.status));
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("AI provider returned an empty response.");
  return extractJson(text);
}

async function generateScriptWithProviders(env, project) {
  const targetSeconds = Number(project.duration_seconds) || 45;
  const targetWords = Math.round(targetSeconds * 2.25);
  const minWords = Math.round(targetWords * 0.92);
  const maxWords = Math.round(targetWords * 1.08);
  const prompt = [
    "Create a complete, fully narrated short-form vertical video script using this project brief.",
    "Return this exact JSON structure:",
    '{"title":"...","hook":"...","narration":"...","scenes":[{"scene":1,"duration_seconds":5,"voiceover":"...","visual_prompt":"...","on_screen_text":"...","transition":"..."}],"closing":"...","cta":"...","estimated_duration_seconds":45}',
    "CRITICAL DURATION RULE: narration must contain between " + minWords + " and " + maxWords + " spoken words. Aim for " + targetWords + " words. This is mandatory; do not write a short summary.",
    "Use a natural short-form speaking pace of about 135 words per minute. Do not count title, hook labels, scene descriptions, on-screen text, or CTA labels toward the narration word count.",
    "The narration field must contain the complete spoken script from opening hook through closing and CTA, not just an outline. Include enough explanation, examples, and transitions to fill the duration without padding or repetition.",
    "Split the same complete narration across scene voiceover fields in the same order. The combined scene voiceovers must closely match the narration; do not omit paragraphs or shorten it.",
    "Create enough scenes to cover the entire target duration, with scene durations adding up to approximately " + targetSeconds + " seconds.",
    "Write all audience-facing text in the requested language; make the hook compelling in the first 2 seconds; use concise visual prompts; do not invent factual claims for news or educational topics; use a strong but natural CTA.",
    "Topic: " + project.topic,
    "Language: " + ({id:"Indonesian",en:"English",ms:"Malay"}[project.language] || "Indonesian"),
    "Target duration: " + targetSeconds + " seconds",
    "Style: " + project.style
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

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") return new Response(null, { status: 204 });

  if (path === "/health" && method === "GET") {
    let database = false;
    let storage = false;
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      database = true;
    } catch {}
    try {
      await env.MEDIA.list({ limit: 1 });
      storage = true;
    } catch {}
    const ok = database && storage;
    return json({
      ok,
      service: "FacelessLab API",
      version: "0.3.0",
      checks: { database, storage },
      timestamp: new Date().toISOString()
    }, ok ? 200 : 503);
  }

  if (path === "/" && method === "GET") {
    return json({
      name: env.APP_NAME || "FacelessLab",
      version: "0.4.0",
      endpoints: ["/health", "/api/auth/register", "/api/auth/login", "/api/me", "/api/projects", "/api/projects/:id/generate-script", "/api/projects/:id/generate-voice (Cloudflare Workers AI MeloTTS)", "/api/projects/:id/voice", "/api/projects/:id/voice/audio"]
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
    if (voiceMatch && method === "POST") {
      const projectId = voiceMatch[1];
      const project = await env.DB.prepare("SELECT id, language FROM projects WHERE id = ? AND user_id = ?").bind(projectId, user.id).first();
      if (!project) return json({ ok: false, error: "Project not found." }, 404);
      if (project.language !== "en") return json({ ok: false, error: "MeloTTS is currently enabled for English projects only. Create an English project to generate this voice-over." }, 422);
      if (!env.AI || typeof env.AI.run !== "function") return json({ ok: false, error: "Cloudflare Workers AI binding is missing. Add an AI binding named AI to this Worker." }, 503);
      const scriptRow = await env.DB.prepare("SELECT output_json FROM generations WHERE project_id = ? AND user_id = ? AND stage = 'script' AND status = 'completed' ORDER BY created_at DESC LIMIT 1").bind(projectId, user.id).first();
      if (!scriptRow) return json({ ok: false, error: "Generate a script before creating the voice-over." }, 409);
      const script = JSON.parse(scriptRow.output_json);
      const narration = String(script.narration || (script.scenes || []).map(s => s.voiceover || "").join(" ")).trim();
      if (!narration) return json({ ok: false, error: "The saved script has no narration text." }, 422);
      if (narration.length > 4500) return json({ ok: false, error: "Narration is too long. Keep it under 4,500 characters for now." }, 413);
      const generationId = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO generations (id, project_id, user_id, stage, status, input_json) VALUES (?, ?, ?, 'voice', 'processing', ?)").bind(generationId, projectId, user.id, JSON.stringify({ provider: "cloudflare-workers-ai", model: "@cf/myshell-ai/melotts", language: "en", characters: narration.length })).run();
      try {
        const result = await env.AI.run("@cf/myshell-ai/melotts", { prompt: narration, lang: "en" });
        const encodedAudio = typeof result === "string" ? result : result?.audio;
        if (!encodedAudio || typeof encodedAudio !== "string") throw new Error("MeloTTS returned no MP3 audio. Please retry.");
        const binary = atob(encodedAudio);
        const audio = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) audio[i] = binary.charCodeAt(i);
        const objectKey = "users/" + user.id + "/projects/" + projectId + "/voice/" + generationId + ".mp3";
        await env.MEDIA.put(objectKey, audio, { httpMetadata: { contentType: "audio/mpeg", cacheControl: "private, max-age=3600" }, customMetadata: { userId: user.id, projectId, generationId } });
        const output = { object_key: objectKey, mime_type: "audio/mpeg", bytes: audio.byteLength, provider: "cloudflare-workers-ai", model: "@cf/myshell-ai/melotts", language: "en", characters: narration.length };
        await env.DB.prepare("UPDATE generations SET status='completed', output_json=?, updated_at=unixepoch() WHERE id=? AND user_id=?").bind(JSON.stringify(output), generationId, user.id).run();
        return json({ ok: true, generation_id: generationId, voice: output }, 201);
      } catch (error) {
        await env.DB.prepare("UPDATE generations SET status='failed', error_message=?, updated_at=unixepoch() WHERE id=? AND user_id=?").bind(String(error.message || error).slice(0, 500), generationId, user.id).run();
        const message = String(error.message || "Voice generation failed.");
        return json({ ok: false, error: message }, /limit|quota|billing|exceeded/i.test(message) ? 429 : 502);
      }
    }

    const voiceInfoMatch = path.match(/^\/api\/projects\/([a-f0-9-]+)\/voice$/i);
    if (voiceInfoMatch && method === "GET") {
      const projectId=voiceInfoMatch[1];
      const project=await env.DB.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").bind(projectId,user.id).first();
      if(!project) return json({ok:false,error:"Project not found."},404);
      const voice=await env.DB.prepare("SELECT id,output_json,created_at FROM generations WHERE project_id=? AND user_id=? AND stage='voice' AND status='completed' ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id).first();
      return json({ok:true,voice:voice?{generation_id:voice.id,...JSON.parse(voice.output_json),created_at:voice.created_at}:null});
    }

    const voiceAudioMatch = path.match(/^\/api\/projects\/([a-f0-9-]+)\/voice\/audio$/i);
    if (voiceAudioMatch && method === "GET") {
      const projectId=voiceAudioMatch[1];
      const project=await env.DB.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").bind(projectId,user.id).first();
      if(!project) return json({ok:false,error:"Project not found."},404);
      const voice=await env.DB.prepare("SELECT output_json FROM generations WHERE project_id=? AND user_id=? AND stage='voice' AND status='completed' ORDER BY created_at DESC LIMIT 1").bind(projectId,user.id).first();
      if(!voice) return json({ok:false,error:"No voice-over has been generated yet."},404);
      const meta=JSON.parse(voice.output_json);
      const object=await env.MEDIA.get(meta.object_key);
      if(!object) return json({ok:false,error:"Audio file is missing from storage."},404);
      return new Response(object.body,{headers:{"content-type":"audio/mpeg","content-length":String(meta.bytes),"content-disposition":'inline; filename="facelesslab-voice.mp3"',"cache-control":"private, no-store"}});
    }

    const scriptMatch = path.match(/^\/api\/projects\/([a-f0-9-]+)\/generate-script$/i);
    if (scriptMatch && method === "POST") {
      const projectId = scriptMatch[1];
      const project = await env.DB.prepare(
        "SELECT id, user_id, title, topic, language, duration_seconds, style FROM projects WHERE id = ? AND user_id = ?"
      ).bind(projectId, user.id).first();
      if (!project) return json({ ok: false, error: "Project not found." }, 404);
      const latest = await env.DB.prepare(
        "SELECT id, output_json FROM generations WHERE project_id = ? AND user_id = ? AND stage = 'script' AND status = 'completed' ORDER BY created_at DESC LIMIT 1"
      ).bind(projectId, user.id).first();
      if (latest) {
        const cachedScript = JSON.parse(latest.output_json);
        const cachedWords = String(cachedScript.narration || "").trim().split(/\s+/).filter(Boolean).length;
        const expectedWords = Math.round((Number(project.duration_seconds) || 45) * 2.25);
        if (cachedWords >= Math.round(expectedWords * 0.92)) {
          return json({ ok: true, cached: true, generation_id: latest.id, script: cachedScript });
        }
        // Older short scripts are regenerated once using the stricter duration target below.
      }
      const generationId = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO generations (id, project_id, user_id, stage, status, input_json) VALUES (?, ?, ?, 'script', 'processing', ?)"
      ).bind(generationId, projectId, user.id, JSON.stringify({ topic: project.topic, language: project.language, duration_seconds: project.duration_seconds, style: project.style })).run();
      try {
        const result = await generateScriptWithProviders(env, project);
        const script = result.script;
        if (!script || typeof script !== "object" || !Array.isArray(script.scenes) || !script.narration) {
          throw new Error("AI response is missing required script fields.");
        }
        await env.DB.prepare(
          "UPDATE generations SET status = 'completed', output_json = ?, updated_at = unixepoch() WHERE id = ? AND user_id = ?"
        ).bind(JSON.stringify({ ...script, _provider: result.provider }), generationId, user.id).run();
        return json({ ok: true, cached: false, generation_id: generationId, script: { ...script, _provider: result.provider } }, 201);
      } catch (error) {
        await env.DB.prepare(
          "UPDATE generations SET status = 'failed', error_message = ?, updated_at = unixepoch() WHERE id = ? AND user_id = ?"
        ).bind(String(error.message || error).slice(0, 500), generationId, user.id).run();
        return json({ ok: false, error: String(error.message || "Script generation failed.") }, 502);
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
      const scriptRow = await env.DB.prepare("SELECT output_json FROM generations WHERE project_id = ? AND user_id = ? AND stage = 'script' AND status = 'completed' ORDER BY created_at DESC LIMIT 1").bind(projectId, user.id).first();
      if (!scriptRow) return json({ ok: false, error: "Generate a script before creating subtitles." }, 409);
      const script = JSON.parse(scriptRow.output_json);
      const narration = String(script.narration || "").replace(/\s+/g, " ").trim();
      if (!narration) return json({ ok: false, error: "The saved script has no narration." }, 422);
      const sentences = narration.match(/[^.!?]+[.!?]?/g) || [narration];
      const chunks = [];
      let words = [];
      for (const sentence of sentences) {
        const sentenceWords = sentence.trim().split(/\s+/).filter(Boolean);
        while (sentenceWords.length) {
          const room = Math.max(1, 9 - words.length);
          words.push(...sentenceWords.splice(0, room));
          if (words.length >= 7 || !sentenceWords.length && words.length >= 4) {
            chunks.push(words.join(" "));
            words = [];
          }
        }
      }
      if (words.length) chunks.push(words.join(" "));
      const totalWords = chunks.reduce((sum, chunk) => sum + chunk.split(/\s+/).length, 0);
      const duration = Math.max(10, Number(project.duration_seconds) || 45);
      let cursor = 0;
      const cues = chunks.map((caption, index) => {
        const count = caption.split(/\s+/).length;
        const start = cursor;
        cursor = index === chunks.length - 1 ? duration : cursor + duration * count / totalWords;
        return { index: index + 1, start: Number(start.toFixed(3)), end: Number(cursor.toFixed(3)), text: caption };
      });
      const subtitleData = { format: "webvtt", timing: "estimated", duration_seconds: duration, cues };
      const generationId = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO generations (id, project_id, user_id, stage, status, input_json, output_json) VALUES (?, ?, ?, 'subtitles', 'completed', ?, ?)").bind(generationId, projectId, user.id, JSON.stringify({ source: "script narration", timing: "estimated", duration_seconds: duration }), JSON.stringify(subtitleData)).run();
      return json({ ok: true, subtitles: subtitleData, generation_id: generationId }, 201);
    }

    const existingScriptMatch = path.match(/^\/api\/projects\/([a-f0-9-]+)\/script$/i);
    if (existingScriptMatch && method === "GET") {
      const projectId = existingScriptMatch[1];
      const result = await env.DB.prepare(
        "SELECT id, output_json, created_at FROM generations WHERE project_id = ? AND user_id = ? AND stage = 'script' AND status = 'completed' ORDER BY created_at DESC LIMIT 1"
      ).bind(projectId, user.id).first();
      return json({ ok: true, script: result ? JSON.parse(result.output_json) : null, generation_id: result?.id || null });
    }

    if (path === "/api/projects" && method === "GET") {
      const result = await env.DB.prepare(
        "SELECT id, title, topic, status, aspect_ratio, language, duration_seconds, style, created_at, updated_at FROM projects WHERE user_id = ? ORDER BY created_at DESC LIMIT 100"
      ).bind(user.id).all();
      return json({ ok: true, projects: result.results || [] });
    }
    if (path === "/api/projects" && method === "POST") {
      const body = await request.json().catch(() => null);
      const topic = String(body?.topic || "").trim();
      if (topic.length < 5 || topic.length > 5000) return json({ ok: false, error: "Topic must be between 5 and 5000 characters." }, 400);
      const language = ["id", "en", "ms"].includes(body?.language) ? body.language : "id";
      const duration = [30, 45, 60].includes(Number(body?.duration)) ? Number(body.duration) : 45;
      const styles = ["storytelling", "educational", "toplist", "motivation", "news"];
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

export default {
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
      return json({ ok: false, error: "Internal server error", detail: env.APP_ENV === "development" ? String(error?.stack || error) : undefined }, 500, headers);
    }
  }
};
