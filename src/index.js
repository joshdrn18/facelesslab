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
      version: "0.2.0",
      checks: { database, storage },
      timestamp: new Date().toISOString()
    }, ok ? 200 : 503);
  }

  if (path === "/" && method === "GET") {
    return json({
      name: env.APP_NAME || "FacelessLab",
      version: "0.2.0",
      endpoints: ["/health", "/api/auth/register", "/api/auth/login", "/api/me", "/api/projects"]
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
