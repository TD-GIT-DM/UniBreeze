/**
 * UniBreeze — Cloudflare Worker (full-stack)
 *
 * College-process tracker: per-school checklists, deadlines, a document vault,
 * and AI worksheet import that turns counselor handouts into tracked tasks.
 *
 * Routing:
 *   /api/*  -> this Worker (auth, D1, R2, Claude)
 *   /*      -> static front-end from ./public (ASSETS binding)
 *
 * Bindings (wrangler.jsonc):
 *   env.DB                -> D1 SQL database
 *   env.BUCKET            -> R2 object storage
 *   env.ASSETS            -> static assets
 * Secrets / vars:
 *   env.ANTHROPIC_API_KEY -> Claude API key (Worker secret; AI features no-op without it)
 *   env.ANTHROPIC_MODEL   -> optional model override
 */

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
}

// ---- helpers ----------------------------------------------------------------

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const SESSION_COOKIE = "ub_session";
const SESSION_DAYS = 30;

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pbkdf2(password: string, saltHex: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = Uint8Array.from(saltHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    key,
    256,
  );
  return hex(bits);
}

// constant-time string compare
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

interface User {
  id: number;
  email: string;
  display_name: string | null;
  grad_year: number | null;
}

async function getUser(request: Request, env: Env): Promise<User | null> {
  const token = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.grad_year
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > datetime('now')`,
  )
    .bind(token)
    .first<User>();
  return row ?? null;
}

const isEmail = (s: unknown): s is string => typeof s === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

// ---- Claude worksheet parsing ----------------------------------------------

interface ProposedTask {
  title: string;
  details?: string;
  category?: string;
  due_date?: string;
  priority?: number;
  tips?: string;
}

const EXTRACTION_SYSTEM = `You are an assistant inside UniBreeze, a college-application tracker for high-school students.
Given the contents of a counselor handout, worksheet, email, or instructions, extract every concrete action the student must complete.
Return ONLY valid JSON of the form:
{"tasks":[{"title": "...", "details": "...", "category": "essay|form|testing|recommendation|financial-aid|activity|deadline|other", "due_date": "YYYY-MM-DD or empty", "priority": 1, "tips": "one or two practical, encouraging sentences on how to get this done"}]}
Rules:
- title: short, action-first (e.g. "Request counselor recommendation").
- due_date: only if a real date is present or clearly implied; otherwise "".
- priority: 1 high (deadline-driven/blocking), 2 normal, 3 low.
- tips: concrete and student-friendly. No fluff.
- Do not invent tasks that aren't supported by the source. If none, return {"tasks":[]}.
- Output JSON only — no markdown, no commentary.`;

async function callClaude(env: Env, content: any[]): Promise<ProposedTask[]> {
  if (!env.ANTHROPIC_API_KEY) throw new Error("AI is not configured yet (missing ANTHROPIC_API_KEY).");
  const model = env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: EXTRACTION_SYSTEM,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Claude API error ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as any;
  const text: string = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  let parsed: any;
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("Could not parse AI response.");
  }
  const tasks: ProposedTask[] = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  return tasks
    .filter((t) => t && typeof t.title === "string" && t.title.trim())
    .map((t) => ({
      title: String(t.title).slice(0, 300),
      details: t.details ? String(t.details).slice(0, 2000) : "",
      category: t.category ? String(t.category) : "other",
      due_date: /^\d{4}-\d{2}-\d{2}$/.test(String(t.due_date)) ? String(t.due_date) : "",
      priority: [1, 2, 3].includes(Number(t.priority)) ? Number(t.priority) : 2,
      tips: t.tips ? String(t.tips).slice(0, 600) : "",
    }));
}

function bufToBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(binary);
}

// ---- router -----------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      // -- Health (public) --
      if (path === "/api/health") {
        return json({ ok: true, service: "unibreeze", ai: Boolean(env.ANTHROPIC_API_KEY), time: new Date().toISOString() });
      }

      // ---- Auth (public) ----
      if (path === "/api/auth/signup" && method === "POST") {
        const b = (await request.json().catch(() => ({}))) as any;
        if (!isEmail(b.email)) return json({ error: "Valid email required." }, 400);
        if (typeof b.password !== "string" || b.password.length < 8)
          return json({ error: "Password must be at least 8 characters." }, 400);
        const email = b.email.toLowerCase();
        const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
        if (exists) return json({ error: "An account with that email already exists." }, 409);
        const salt = randomHex(16);
        const hash = await pbkdf2(b.password, salt);
        const ins = await env.DB.prepare(
          "INSERT INTO users (email, password_hash, salt, display_name, grad_year) VALUES (?, ?, ?, ?, ?)",
        )
          .bind(email, hash, salt, b.display_name ? String(b.display_name).slice(0, 80) : null, Number.isInteger(b.grad_year) ? b.grad_year : null)
          .run();
        const token = await startSession(env, Number(ins.meta.last_row_id));
        return json({ ok: true, user: { email } }, 200, { "set-cookie": sessionCookie(token, SESSION_DAYS * 86400) });
      }

      if (path === "/api/auth/login" && method === "POST") {
        const b = (await request.json().catch(() => ({}))) as any;
        if (!isEmail(b.email) || typeof b.password !== "string") return json({ error: "Email and password required." }, 400);
        const email = b.email.toLowerCase();
        const u = await env.DB.prepare("SELECT id, password_hash, salt FROM users WHERE email = ?").bind(email).first<any>();
        // Always compute a hash to reduce timing signal even when user is absent.
        const salt = u?.salt ?? randomHex(16);
        const hash = await pbkdf2(b.password, salt);
        if (!u || !timingSafeEqual(hash, u.password_hash)) return json({ error: "Incorrect email or password." }, 401);
        const token = await startSession(env, u.id);
        return json({ ok: true, user: { email } }, 200, { "set-cookie": sessionCookie(token, SESSION_DAYS * 86400) });
      }

      if (path === "/api/auth/logout" && method === "POST") {
        const token = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
        if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
        return json({ ok: true }, 200, { "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
      }

      // ---- Everything below requires auth ----
      const user = await getUser(request, env);
      if (path === "/api/auth/me") return user ? json({ user }) : json({ user: null }, 200);
      if (!user) return json({ error: "Not authenticated." }, 401);

      // ---- Schools ----
      if (path === "/api/schools" && method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM schools WHERE user_id = ? ORDER BY COALESCE(deadline,'9999') ASC, id DESC",
        ).bind(user.id).all();
        return json({ schools: results });
      }
      if (path === "/api/schools" && method === "POST") {
        const b = (await request.json().catch(() => ({}))) as any;
        if (!b.name || !String(b.name).trim()) return json({ error: "School name required." }, 400);
        const r = await env.DB.prepare(
          "INSERT INTO schools (user_id, name, platform, app_round, deadline, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
          .bind(user.id, String(b.name).slice(0, 160), b.platform ?? null, b.app_round ?? null, cleanDate(b.deadline), b.status ?? "considering", b.notes ?? null)
          .run();
        return json({ ok: true, id: r.meta.last_row_id });
      }
      const schoolMatch = path.match(/^\/api\/schools\/(\d+)$/);
      if (schoolMatch && (method === "PATCH" || method === "PUT")) {
        const id = Number(schoolMatch[1]);
        const b = (await request.json().catch(() => ({}))) as any;
        const fields = pick(b, ["name", "platform", "app_round", "deadline", "status", "notes"]);
        if ("deadline" in fields) fields.deadline = cleanDate(fields.deadline);
        if (!Object.keys(fields).length) return json({ error: "No fields to update." }, 400);
        await updateRow(env, "schools", id, user.id, fields);
        return json({ ok: true });
      }
      if (schoolMatch && method === "DELETE") {
        await env.DB.prepare("DELETE FROM schools WHERE id = ? AND user_id = ?").bind(Number(schoolMatch[1]), user.id).run();
        return json({ ok: true });
      }

      // ---- Tasks ----
      if (path === "/api/tasks" && method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM tasks WHERE user_id = ? ORDER BY status='done', priority ASC, COALESCE(due_date,'9999') ASC, id DESC",
        ).bind(user.id).all();
        return json({ tasks: results });
      }
      if (path === "/api/tasks" && method === "POST") {
        const b = (await request.json().catch(() => ({}))) as any;
        if (!b.title || !String(b.title).trim()) return json({ error: "Task title required." }, 400);
        const r = await insertTask(env, user.id, b);
        return json({ ok: true, id: r });
      }
      if (path === "/api/tasks/bulk" && method === "POST") {
        const b = (await request.json().catch(() => ({}))) as any;
        const list: any[] = Array.isArray(b.tasks) ? b.tasks : [];
        let count = 0;
        for (const t of list) {
          if (t && String(t.title || "").trim()) {
            await insertTask(env, user.id, { ...t, school_id: b.school_id ?? t.school_id, source: b.source ?? t.source ?? "import" });
            count++;
          }
        }
        return json({ ok: true, added: count });
      }
      const taskMatch = path.match(/^\/api\/tasks\/(\d+)$/);
      if (taskMatch && (method === "PATCH" || method === "PUT")) {
        const id = Number(taskMatch[1]);
        const b = (await request.json().catch(() => ({}))) as any;
        const fields = pick(b, ["title", "details", "category", "due_date", "status", "priority", "school_id", "tips"]);
        if ("due_date" in fields) fields.due_date = cleanDate(fields.due_date);
        if (!Object.keys(fields).length) return json({ error: "No fields to update." }, 400);
        fields.updated_at = new Date().toISOString();
        await updateRow(env, "tasks", id, user.id, fields);
        return json({ ok: true });
      }
      if (taskMatch && method === "DELETE") {
        await env.DB.prepare("DELETE FROM tasks WHERE id = ? AND user_id = ?").bind(Number(taskMatch[1]), user.id).run();
        return json({ ok: true });
      }

      // ---- Documents ----
      if (path === "/api/documents" && method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT id, filename, content_type, size, parsed, created_at FROM documents WHERE user_id = ? ORDER BY id DESC",
        ).bind(user.id).all();
        return json({ documents: results });
      }
      if (path === "/api/documents" && method === "POST") {
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) return json({ error: "No file uploaded." }, 400);
        if (file.size > 15 * 1024 * 1024) return json({ error: "File too large (15MB max)." }, 400);
        const key = `u${user.id}/${randomHex(8)}-${file.name}`.slice(0, 400);
        await env.BUCKET.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
        const r = await env.DB.prepare(
          "INSERT INTO documents (user_id, r2_key, filename, content_type, size) VALUES (?, ?, ?, ?, ?)",
        ).bind(user.id, key, file.name.slice(0, 240), file.type || null, file.size).run();
        return json({ ok: true, id: r.meta.last_row_id });
      }
      const docMatch = path.match(/^\/api\/documents\/(\d+)$/);
      if (docMatch && method === "DELETE") {
        const id = Number(docMatch[1]);
        const doc = await env.DB.prepare("SELECT r2_key FROM documents WHERE id = ? AND user_id = ?").bind(id, user.id).first<any>();
        if (doc) {
          await env.BUCKET.delete(doc.r2_key);
          await env.DB.prepare("DELETE FROM documents WHERE id = ? AND user_id = ?").bind(id, user.id).run();
        }
        return json({ ok: true });
      }
      const docDl = path.match(/^\/api\/documents\/(\d+)\/download$/);
      if (docDl && method === "GET") {
        const doc = await env.DB.prepare("SELECT r2_key, filename, content_type FROM documents WHERE id = ? AND user_id = ?")
          .bind(Number(docDl[1]), user.id).first<any>();
        if (!doc) return json({ error: "Not found." }, 404);
        const obj = await env.BUCKET.get(doc.r2_key);
        if (!obj) return json({ error: "Not found." }, 404);
        return new Response(obj.body, {
          headers: {
            "content-type": doc.content_type || "application/octet-stream",
            "content-disposition": `inline; filename="${doc.filename.replace(/"/g, "")}"`,
          },
        });
      }

      // ---- AI worksheet import ----
      // Parse pasted text OR an uploaded document into proposed tasks (no DB writes).
      if (path === "/api/import/parse" && method === "POST") {
        const b = (await request.json().catch(() => ({}))) as any;
        let content: any[];
        if (b.documentId) {
          const doc = await env.DB.prepare("SELECT r2_key, content_type FROM documents WHERE id = ? AND user_id = ?")
            .bind(Number(b.documentId), user.id).first<any>();
          if (!doc) return json({ error: "Document not found." }, 404);
          const obj = await env.BUCKET.get(doc.r2_key);
          if (!obj) return json({ error: "Document file missing." }, 404);
          const ct = doc.content_type || "";
          const buf = await obj.arrayBuffer();
          if (ct === "application/pdf") {
            content = [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: bufToBase64(buf) } },
              { type: "text", text: "Extract the student's action items from this document." },
            ];
          } else if (ct.startsWith("image/")) {
            content = [
              { type: "image", source: { type: "base64", media_type: ct, data: bufToBase64(buf) } },
              { type: "text", text: "Extract the student's action items from this image." },
            ];
          } else {
            const text = new TextDecoder().decode(buf).slice(0, 40000);
            content = [{ type: "text", text: `Extract the student's action items from this document:\n\n${text}` }];
          }
        } else if (typeof b.text === "string" && b.text.trim()) {
          content = [{ type: "text", text: `Extract the student's action items from this:\n\n${b.text.slice(0, 40000)}` }];
        } else {
          return json({ error: "Provide text or a documentId." }, 400);
        }
        try {
          const tasks = await callClaude(env, content);
          return json({ ok: true, tasks });
        } catch (e) {
          return json({ error: String(e instanceof Error ? e.message : e) }, 502);
        }
      }

      return json({ error: "Unknown API route.", path }, 404);
    } catch (err) {
      return json({ error: "Server error.", detail: String(err) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

// ---- db helpers -------------------------------------------------------------

async function startSession(env: Env, userId: number): Promise<string> {
  const token = randomHex(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, userId, expires).run();
  return token;
}

async function insertTask(env: Env, userId: number, t: any): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO tasks (user_id, school_id, title, details, category, due_date, status, priority, tips, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      userId,
      Number.isInteger(t.school_id) ? t.school_id : null,
      String(t.title).slice(0, 300),
      t.details ? String(t.details).slice(0, 2000) : null,
      t.category ? String(t.category).slice(0, 40) : "other",
      cleanDate(t.due_date),
      ["todo", "in_progress", "done"].includes(t.status) ? t.status : "todo",
      [1, 2, 3].includes(Number(t.priority)) ? Number(t.priority) : 2,
      t.tips ? String(t.tips).slice(0, 600) : null,
      t.source ? String(t.source).slice(0, 120) : "manual",
    )
    .run();
  return Number(r.meta.last_row_id);
}

async function updateRow(env: Env, table: string, id: number, userId: number, fields: Record<string, any>): Promise<void> {
  const cols = Object.keys(fields);
  const setSql = cols.map((c) => `${c} = ?`).join(", ");
  const vals = cols.map((c) => fields[c]);
  await env.DB.prepare(`UPDATE ${table} SET ${setSql} WHERE id = ? AND user_id = ?`)
    .bind(...vals, id, userId).run();
}

function pick(obj: any, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of keys) if (k in obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function cleanDate(v: any): string | null {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return null;
}
