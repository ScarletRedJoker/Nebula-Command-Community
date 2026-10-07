import http from "node:http";
import net from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { diagnosticArchive, imageWorkflow, jsonError, redact, safeEndpoint } from "./core.mjs";
import { createCommandService } from "./command.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const TIMEOUT = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const COMMAND_PAGE_ROUTES = new Set([
  "/command",
  "/command/",
  "/command/overview",
  "/command/jarvis",
  "/command/studio",
  "/command/knowledge",
  "/command/research",
  "/command/images",
  "/command/jobs",
  "/command/settings"
]);
const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 }) : null;
const startedAt = new Date().toISOString();
const command = createCommandService({ pool, root: ROOT, timeoutMs: TIMEOUT, logError });

function nebulaEdition() {
  return process.env.NEBULA_EDITION === "command" ? "command" : "community";
}

function configuredHosts() {
  return [process.env.OLLAMA_URL, process.env.OPENAI_COMPATIBLE_URL, process.env.COMFYUI_URL]
    .flatMap((raw) => { try { return raw ? [new URL(raw).hostname] : []; } catch { return []; } });
}

function logError(context, error) {
  console.error(JSON.stringify({ level: "error", component: "community", context, error: redact(String(error?.message || error), "", configuredHosts()) }));
}

function send(res, status, body, headers = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", "content-length": data.length, "cache-control": "no-store", ...headers });
  res.end(data);
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(TIMEOUT) });
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { value = { message: text.slice(0, 300) }; }
  if (!response.ok) throw new Error(value.error?.message || value.message || `Upstream returned ${response.status}`);
  return value;
}

async function dbStatus() {
  if (!pool) return { state: "disabled", detail: "DATABASE_URL is not configured" };
  try {
    const result = await pool.query("SELECT count(*)::int AS count FROM schema_migrations");
    return { state: "online", migrations: result.rows[0].count };
  } catch (error) {
    logError("database_health", error);
    return { state: "degraded", detail: "Database connection failed" };
  }
}

async function redisStatus() {
  if (!process.env.REDIS_URL) return { state: "disabled", detail: "REDIS_URL is not configured" };
  try {
    const url = new URL(process.env.REDIS_URL);
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: url.hostname, port: Number(url.port || 6379) });
      const timer = setTimeout(() => socket.destroy(new Error("Timed out")), 1200);
      socket.once("connect", () => socket.write("*1\r\n$4\r\nPING\r\n"));
      socket.once("data", (data) => data.toString().includes("PONG") ? (clearTimeout(timer), socket.end(), resolve()) : reject(new Error("Unexpected response")));
      socket.once("error", reject);
    });
    return { state: "online" };
  } catch (error) {
    logError("redis_health", error);
    return { state: "degraded", detail: "Redis connection failed" };
  }
}

async function endpointStatus(raw, fallback, path = "") {
  if (!raw && !fallback) return { state: "disabled", detail: "Not configured" };
  try {
    const url = safeEndpoint(raw, fallback);
    if (path) {
      const [pathname, query = ""] = path.split("?");
      url.pathname = pathname;
      url.search = query ? `?${query}` : "";
    }
    const response = await fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(1500) });
    return { state: response.ok ? "online" : "degraded", detail: response.ok ? "Endpoint responded" : `Endpoint returned HTTP ${response.status}` };
  } catch (error) {
    logError("inference_health", error);
    return { state: "offline", detail: "Configured endpoint is unavailable" };
  }
}

async function ollamaModelStatus(model) {
  if (!model) return { state: "disabled", detail: "EMBED_MODEL is not configured" };
  if (!process.env.OLLAMA_URL) return { state: "disabled", detail: "OLLAMA_URL is not configured" };
  try {
    const url = safeEndpoint("", process.env.OLLAMA_URL);
    url.pathname = "/api/tags";
    url.search = "";
    const response = await fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { state: "degraded", detail: `Ollama model list returned HTTP ${response.status}` };
    const payload = await response.json();
    const expected = String(model).replace(/:latest$/, "");
    const installed = Array.isArray(payload.models) && payload.models.some((entry) => {
      const name = String(entry?.name || entry?.model || "").replace(/:latest$/, "");
      return name === expected;
    });
    return installed
      ? { state: "online", detail: `${model} is installed` }
      : { state: "degraded", detail: `${model} is not installed` };
  } catch (error) {
    logError("embedding_health", error);
    return { state: "offline", detail: "Configured embedding service is unavailable" };
  }
}

async function status() {
  const edition = nebulaEdition();
  const [database, redis, chat, images] = await Promise.all([
    dbStatus(), redisStatus(),
    endpointStatus(process.env.OLLAMA_URL || process.env.OPENAI_COMPATIBLE_URL),
    endpointStatus(process.env.COMFYUI_URL)
  ]);
  const services = { database, redis, chat, images };
  if (edition === "command") {
    const [jarvis, search, embed, gpu] = await Promise.all([
      endpointStatus(process.env.OLLAMA_URL, "", "/api/tags"),
      endpointStatus(process.env.SEARXNG_URL, "", "/search?q=nebula-health&format=json"),
      ollamaModelStatus(process.env.EMBED_MODEL),
      endpointStatus(process.env.GPU_STATUS_URL)
    ]);
    Object.assign(services, { jarvis, search, embed, gpu });
  }
  const unavailable = Object.values(services).some((service) => ["offline", "degraded"].includes(service.state));
  const state = edition === "community"
    ? (Object.values(services).some((service) => service.state !== "online") ? "degraded" : "healthy")
    : (unavailable ? "degraded" : "healthy");
  return { version: "0.1.0", edition, startedAt, state, services };
}

async function persistChat(id, provider, model, prompt, answer) {
  if (!pool) return;
  try {
    await pool.query("INSERT INTO conversations(id, provider, model) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [id, provider, model]);
    await pool.query("INSERT INTO messages(conversation_id, role, content) VALUES($1,'user',$2),($1,'assistant',$3)", [id, prompt, answer]);
  } catch {
    // Inference remains available while database health reports the storage failure.
  }
}

async function chat(input) {
  const prompt = String(input.message || "").trim();
  if (!prompt) throw new Error("Message is required");
  const provider = input.provider === "ollama" ? "ollama" : "openai";
  if (input.endpoint !== undefined) {
    const error = new Error("Endpoint override is not permitted");
    error.code = "endpoint_override_forbidden";
    throw error;
  }
  const base = safeEndpoint("", provider === "ollama" ? process.env.OLLAMA_URL : process.env.OPENAI_COMPATIBLE_URL);
  const model = String(input.model || (provider === "ollama" ? "llama3.2" : "local-model"));
  const target = new URL(provider === "ollama" ? "/api/chat" : `${base.pathname.replace(/\/$/, "")}/chat/completions`, base);
  const headers = { "content-type": "application/json" };
  if (input.apiKey) headers.authorization = `Bearer ${input.apiKey}`;
  const payload = provider === "ollama"
    ? { model, stream: false, messages: [{ role: "user", content: prompt }] }
    : { model, stream: false, messages: [{ role: "user", content: prompt }] };
  const result = await fetchJson(target, { method: "POST", headers, body: JSON.stringify(payload) });
  const answer = provider === "ollama" ? result.message?.content : result.choices?.[0]?.message?.content;
  if (!answer) throw new Error("Inference endpoint returned no assistant message");
  const conversationId = input.conversationId || randomUUID();
  await persistChat(conversationId, provider, model, prompt, answer);
  return { conversationId, message: { role: "assistant", content: answer }, model };
}

async function image(input) {
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("Prompt is required");
  if (input.endpoint !== undefined) {
    const error = new Error("Endpoint override is not permitted");
    error.code = "endpoint_override_forbidden";
    throw error;
  }
  const base = safeEndpoint("", process.env.COMFYUI_URL);
  const id = randomUUID();
  const result = await fetchJson(new URL("/prompt", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: imageWorkflow(prompt, Number(input.seed) || 1), client_id: id }) });
  if (pool) {
    try { await pool.query("INSERT INTO image_jobs(id, remote_id, status, prompt) VALUES($1,$2,'queued',$3)", [id, result.prompt_id || null, prompt]); }
    catch { /* The queued upstream job remains valid while storage is degraded. */ }
  }
  return { id, remoteId: result.prompt_id || null, state: "queued" };
}

async function imageStatus(input) {
  if (!input.remoteId) throw new Error("Remote job ID is required");
  if (input.endpoint !== undefined) {
    const error = new Error("Endpoint override is not permitted");
    error.code = "endpoint_override_forbidden";
    throw error;
  }
  const base = safeEndpoint("", process.env.COMFYUI_URL);
  const history = await fetchJson(new URL(`/history/${encodeURIComponent(input.remoteId)}`, base));
  const job = history[input.remoteId];
  if (!job) return { state: "queued" };
  const descriptor = Object.values(job.outputs || {}).flatMap((output) => output.images || [])[0];
  if (!descriptor) {
    const failed = job.status?.status_str === "error";
    return { state: failed ? "failed" : "running", detail: failed ? "ComfyUI reported an execution error" : undefined };
  }
  const view = new URL("/view", base);
  view.searchParams.set("filename", descriptor.filename);
  view.searchParams.set("subfolder", descriptor.subfolder || "");
  view.searchParams.set("type", descriptor.type || "output");
  const response = await fetch(view, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT) });
  if (!response.ok) throw new Error(`ComfyUI image download returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 10_000_000) throw new Error("Generated image exceeds the 10 MB Community limit");
  const mime = response.headers.get("content-type")?.split(";")[0] || "image/png";
  if (pool && input.id) {
    try { await pool.query("UPDATE image_jobs SET status='complete' WHERE id=$1", [input.id]); }
    catch { /* Completion is still returned when history storage is degraded. */ }
  }
  return { state: "complete", image: `data:${mime};base64,${bytes.toString("base64")}` };
}

async function serveStatic(pathname, res) {
  const names = {
    "/": ["public/index.html", "text/html; charset=utf-8"],
    "/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
    "/styles.css": ["public/styles.css", "text/css; charset=utf-8"],
    "/command/app.js": ["public/command/app.js", "text/javascript; charset=utf-8"],
    "/command/styles.css": ["public/command/styles.css", "text/css; charset=utf-8"]
  };
  let descriptor = names[pathname];
  if (!descriptor && nebulaEdition() === "command" && COMMAND_PAGE_ROUTES.has(pathname)) {
    descriptor = ["public/command/index.html", "text/html; charset=utf-8"];
  }
  if (!descriptor || (pathname.startsWith("/command/") && nebulaEdition() !== "command")) return false;
  const [file, type] = descriptor;
  const data = await readFile(join(ROOT, file));
  send(res, 200, data, { "content-type": type, "cache-control": "no-cache" });
  return true;
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://local.invalid");
    try {
      if (url.pathname.startsWith("/api/") && req.headers.origin) {
        const forwarded = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
        const expected = `${forwarded}://${req.headers.host}`;
        if (req.headers.origin !== expected) return send(res, 403, { error: "origin_forbidden", message: "Cross-origin API requests are not permitted." });
      }
      if (req.method === "GET" && await serveStatic(url.pathname, res)) return;
      const privateApi = url.pathname.startsWith("/api/command/") || url.pathname.startsWith("/api/jarvis/") || url.pathname === "/api/research";
      if (privateApi && nebulaEdition() !== "command") {
        const error = jsonError("not_found", "Route not found", 404);
        return send(res, error.status, error.body);
      }
      if (privateApi && !command.authorize(req)) return send(res, 401, { error: "command_unauthorized", message: "Private Command access requires the configured local access token." });
      if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { status: "ok", version: "0.1.0" });
      if (req.method === "POST" && url.pathname === "/api/status") return send(res, 200, await status());
      if (req.method === "POST" && url.pathname === "/api/chat") return send(res, 200, await chat(await body(req)));
      if (req.method === "POST" && url.pathname === "/api/images") return send(res, 202, await image(await body(req)));
      if (req.method === "POST" && url.pathname === "/api/images/status") return send(res, 200, await imageStatus(await body(req)));
      if (req.method === "GET" && url.pathname === "/api/command/status") return send(res, 200, await command.status());
      if (req.method === "GET" && url.pathname === "/api/command/projects") return send(res, 200, { projects: await command.listProjects() });
      if (req.method === "POST" && url.pathname === "/api/command/projects") return send(res, 201, await command.createProject(await body(req)));
      if (req.method === "GET" && url.pathname === "/api/command/audit") return send(res, 200, { events: await command.auditEvents(url.searchParams.get("limit")) });
      const memoriesMatch = url.pathname.match(/^\/api\/command\/projects\/([^/]+)\/memories$/);
      if (memoriesMatch && req.method === "GET") {
        return send(res, 200, await command.searchMemories(decodeURIComponent(memoriesMatch[1]), url.searchParams.get("q")));
      }
      if (memoriesMatch && req.method === "POST") {
        return send(res, 201, await command.saveMemory(decodeURIComponent(memoriesMatch[1]), await body(req)));
      }
      const memoryRebuildMatch = url.pathname.match(/^\/api\/command\/projects\/([^/]+)\/memories\/rebuild$/);
      if (memoryRebuildMatch && req.method === "POST") {
        return send(res, 200, await command.rebuildMemoryEmbeddings(decodeURIComponent(memoryRebuildMatch[1]), await body(req)));
      }
      const filesMatch = url.pathname.match(/^\/api\/command\/projects\/([^/]+)\/files$/);
      if (filesMatch && req.method === "GET") {
        const slug = decodeURIComponent(filesMatch[1]);
        const requested = url.searchParams.get("path") || "";
        if (!requested) return send(res, 200, { files: await command.listFiles(slug) });
        return send(res, 200, await command.readWorkspaceFile(slug, requested));
      }
      if (filesMatch && req.method === "POST") {
        const input = await body(req);
        return send(res, 200, await command.writeWorkspaceFile(decodeURIComponent(filesMatch[1]), input.path, input.content, input.confirm));
      }
      const runMatch = url.pathname.match(/^\/api\/command\/projects\/([^/]+)\/run$/);
      if (runMatch && req.method === "POST") return send(res, 200, await command.runWorkspaceCommand(decodeURIComponent(runMatch[1]), await body(req)));
      const planMatch = url.pathname.match(/^\/api\/command\/projects\/([^/]+)\/tasks\/plan$/);
      if (planMatch && req.method === "POST") {
        return send(res, 200, await command.planWorkspaceTask(decodeURIComponent(planMatch[1]), await body(req)));
      }
      const taskMatch = url.pathname.match(/^\/api\/command\/projects\/([^/]+)\/tasks$/);
      if (taskMatch && req.method === "POST") {
        return send(res, 202, await command.startWorkspaceTask(decodeURIComponent(taskMatch[1]), await body(req)));
      }
      const taskStatusMatch = url.pathname.match(/^\/api\/command\/tasks\/([^/]+)$/);
      if (taskStatusMatch && req.method === "GET") {
        return send(res, 200, await command.getWorkspaceTask(decodeURIComponent(taskStatusMatch[1])));
      }
      const taskApprovalMatch = url.pathname.match(/^\/api\/command\/tasks\/([^/]+)\/approve$/);
      if (taskApprovalMatch && req.method === "POST") {
        const input = await body(req);
        return send(res, 200, await command.approveWorkspaceTask(decodeURIComponent(taskApprovalMatch[1]), input.approved !== false));
      }
      const taskCancelMatch = url.pathname.match(/^\/api\/command\/tasks\/([^/]+)\/cancel$/);
      if (taskCancelMatch && req.method === "POST") {
        return send(res, 200, await command.cancelWorkspaceTask(decodeURIComponent(taskCancelMatch[1])));
      }
      if (req.method === "POST" && url.pathname === "/api/jarvis/chat") return send(res, 200, await command.jarvisChat(await body(req)));
      if (req.method === "GET" && url.pathname === "/api/research") return send(res, 200, await command.research(url.searchParams.get("q"), url.searchParams.get("project")));
      if (req.method === "POST" && url.pathname === "/api/diagnostics") {
        await body(req);
        const report = { generatedAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch }, health: await status(), configuration: { database: Boolean(process.env.DATABASE_URL), redis: Boolean(process.env.REDIS_URL), ollama: Boolean(process.env.OLLAMA_URL), openaiCompatible: Boolean(process.env.OPENAI_COMPATIBLE_URL), comfyui: Boolean(process.env.COMFYUI_URL), searxng: Boolean(process.env.SEARXNG_URL), embed: Boolean(process.env.EMBED_MODEL), gpu: Boolean(process.env.GPU_STATUS_URL) }, note: "Prompts, conversations, cookies, headers, logs, endpoint URLs, and raw settings are intentionally excluded." };
        const archive = diagnosticArchive(report, configuredHosts());
        return send(res, 200, archive, { "content-type": "application/gzip", "content-disposition": `attachment; filename="nebula-diagnostics-${Date.now()}.json.gz"` });
      }
      const error = jsonError("not_found", "Route not found", 404);
      return send(res, error.status, error.body);
    } catch (error) {
      const offline = error.name === "TimeoutError" || error.cause || /fetch|connect|timed out/i.test(error.message);
      logError(`${req.method} ${url.pathname}`, error);
      const result = error.code === "endpoint_override_forbidden"
        ? jsonError("endpoint_override_forbidden", "Endpoint selection is managed by server configuration.", 400)
        : error.code === "command_unauthorized"
        ? jsonError("command_unauthorized", "Private Command access is not authorized.", 401)
        : error.code === "approval_required"
        ? jsonError("approval_required", error.message, 409)
        : error.code === "command_not_allowed"
        ? jsonError("command_not_allowed", error.message, 400)
        : error.code === "local_model_unavailable"
        ? jsonError("local_model_unavailable", error.message, 503)
        : error.code === "local_model_failed"
        ? jsonError("local_model_failed", error.message, 503)
        : error.code === "memory_backend_invalid"
        ? jsonError("memory_backend_invalid", error.message, 503)
        : error.code === "memory_embedding_unavailable"
        ? jsonError("memory_embedding_unavailable", error.message, 503)
        : error.code === "memory_storage_unavailable"
        ? jsonError("memory_storage_unavailable", error.message, 503)
        : error.code === "project_not_found"
        ? jsonError("project_not_found", error.message, 404)
        : error.code === "task_not_found"
        ? jsonError("task_not_found", error.message, 404)
        : error.code === "task_not_actionable" || /not waiting for approval|declined|cancelled|reaching its time limit|output exceeded/i.test(error.message)
        ? jsonError("task_not_actionable", error.message, 409)
        : error.code === "research_disabled"
        ? jsonError("research_disabled", error.message, 503)
        : offline
        ? jsonError("service_unavailable", "Configured service is unavailable. Check Status and endpoint settings.", 503)
        : jsonError("request_failed", "Unable to complete the request. Review your settings and try again.", 400);
      return send(res, result.status, result.body);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await command.recoverWorkspaceTasks();
  createServer().listen(PORT, HOST, () => console.log(`Nebula Command Community listening on ${HOST}:${PORT}`));
}