/**
 * UniBreeze — Cloudflare Worker (full-stack)
 *
 * Routing:
 *   /api/*  -> handled by this Worker (backend logic, D1, R2)
 *   /*      -> served from ./public via the ASSETS binding (front-end)
 *
 * Bindings (see wrangler.jsonc):
 *   env.DB      -> D1 SQL database
 *   env.BUCKET  -> R2 object storage
 *   env.ASSETS  -> static assets
 */

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ---- API routes -------------------------------------------------------
    if (url.pathname.startsWith("/api/")) {
      try {
        // Health check
        if (url.pathname === "/api/health") {
          return json({ ok: true, service: "unibreeze", time: new Date().toISOString() });
        }

        // D1 demo: list items
        if (url.pathname === "/api/items" && request.method === "GET") {
          const { results } = await env.DB.prepare(
            "SELECT id, name, created_at FROM items ORDER BY id DESC LIMIT 50"
          ).all();
          return json({ items: results });
        }

        // D1 demo: add an item
        if (url.pathname === "/api/items" && request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as { name?: string };
          if (!body.name) return json({ error: "name is required" }, 400);
          const res = await env.DB.prepare("INSERT INTO items (name) VALUES (?)")
            .bind(body.name)
            .run();
          return json({ ok: true, id: res.meta.last_row_id });
        }

        // R2 demo: upload an object  ->  PUT /api/files/<key>
        if (url.pathname.startsWith("/api/files/") && request.method === "PUT") {
          const key = decodeURIComponent(url.pathname.replace("/api/files/", ""));
          await env.BUCKET.put(key, request.body);
          return json({ ok: true, key });
        }

        // R2 demo: download an object  ->  GET /api/files/<key>
        if (url.pathname.startsWith("/api/files/") && request.method === "GET") {
          const key = decodeURIComponent(url.pathname.replace("/api/files/", ""));
          const obj = await env.BUCKET.get(key);
          if (!obj) return json({ error: "not found" }, 404);
          return new Response(obj.body, {
            headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream" },
          });
        }

        return json({ error: "unknown api route", path: url.pathname }, 404);
      } catch (err) {
        return json({ error: "server error", detail: String(err) }, 500);
      }
    }

    // ---- Front-end (static assets) ---------------------------------------
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
