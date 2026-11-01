const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": env.APP_ORIGIN || "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
          "access-control-max-age": "86400"
        }
      });
    }

    let response;
    if (url.pathname === "/health" && request.method === "GET") {
      response = json({
        ok: true,
        service: "FacelessLab API",
        version: "0.1.0",
        environment: env.APP_ENV || "development",
        timestamp: new Date().toISOString()
      });
    } else if (url.pathname === "/" && request.method === "GET") {
      response = json({
        name: env.APP_NAME || "FacelessLab",
        description: "AI-assisted faceless video creation API",
        endpoints: ["/health"]
      });
    } else {
      response = json({ ok: false, error: "Not found" }, 404);
    }

    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", env.APP_ORIGIN || "*");
    headers.set("x-content-type-options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  }
};