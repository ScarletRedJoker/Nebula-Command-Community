import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../src/server.mjs";
import { inspectDiagnosticArchive } from "../src/core.mjs";

function setEnv(t, key, value) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

test("health and unknown routes have stable contracts", async (t) => {
  setEnv(t, "NEBULA_EDITION", "community");
  const server = createServer().listen(0, "localhost");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", version: "0.1.0" });
  const status = await fetch(`${base}/api/status`, { method: "POST" });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.edition, "community");
  assert.deepEqual(Object.keys(statusBody.services), ["database", "redis", "chat", "images"]);
  const commandPage = await fetch(`${base}/command/`);
  assert.equal(commandPage.status, 404);
  const commandApi = await fetch(`${base}/api/command/status`);
  assert.equal(commandApi.status, 404);
  const missing = await fetch(`${base}/api/missing`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "not_found");
});

test("client errors remain generic when an endpoint leaks credentials", async (t) => {
  const server = createServer().listen(0, "localhost");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const response = await fetch(`http://localhost:${server.address().port}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "ollama", endpoint: "http://untrusted.invalid", message: "hello" })
  });
  const result = await response.json();
  assert.equal(result.error, "endpoint_override_forbidden");
  assert.equal(result.message, "Endpoint selection is managed by server configuration.");
});

test("chat and image routes support local-compatible APIs", async (t) => {
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/chat") res.end(JSON.stringify({ message: { content: `Echo: ${payload.messages[0].content}` } }));
    else if (req.url === "/prompt") res.end(JSON.stringify({ prompt_id: "job-one" }));
    else { res.statusCode = 404; res.end("{}"); }
  }).listen(0, "localhost");
  const app = createServer().listen(0, "localhost");
  await Promise.all([new Promise((resolve) => upstream.once("listening", resolve)), new Promise((resolve) => app.once("listening", resolve))]);
  const oldOllama = process.env.OLLAMA_URL;
  const oldComfy = process.env.COMFYUI_URL;
  process.env.OLLAMA_URL = `http://localhost:${upstream.address().port}`;
  process.env.COMFYUI_URL = `http://localhost:${upstream.address().port}`;
  t.after(() => {
    upstream.close(); app.close();
    if (oldOllama === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = oldOllama;
    if (oldComfy === undefined) delete process.env.COMFYUI_URL; else process.env.COMFYUI_URL = oldComfy;
  });
  const endpoint = `http://localhost:${upstream.address().port}`;
  const base = `http://localhost:${app.address().port}`;
  const chatResponse = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "ollama", model: "test", message: "hello" }) });
  assert.equal((await chatResponse.json()).message.content, "Echo: hello");
  const imageResponse = await fetch(`${base}/api/images`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "aurora" }) });
  assert.equal((await imageResponse.json()).remoteId, "job-one");
});

test("API enforces matching Origin headers", async (t) => {
  const server = createServer().listen(0, "localhost");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const denied = await fetch(`${base}/api/health`, { headers: { origin: "https://attacker.invalid" } });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "origin_forbidden");
  const allowed = await fetch(`${base}/api/health`, { headers: { origin: base } });
  assert.equal(allowed.status, 200);
});

test("diagnostics omit caller settings and raw endpoint hosts", async (t) => {
  const server = createServer().listen(0, "localhost");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const endpoint = "http://caller-controlled.invalid/private";
  const response = await fetch(`http://localhost:${server.address().port}/api/diagnostics`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { endpoint } })
  });
  const report = inspectDiagnosticArchive(Buffer.from(await response.arrayBuffer()));
  assert.equal(JSON.stringify(report).includes(endpoint), false);
  assert.equal(typeof report.configuration.ollama, "boolean");
});

test("upstream redirects are treated as unavailable", async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(302, { location: "/other" });
    res.end();
  }).listen(0, "localhost");
  const app = createServer().listen(0, "localhost");
  await Promise.all([new Promise((resolve) => upstream.once("listening", resolve)), new Promise((resolve) => app.once("listening", resolve))]);
  const oldOllama = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = `http://localhost:${upstream.address().port}`;
  t.after(() => {
    upstream.close(); app.close();
    if (oldOllama === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = oldOllama;
  });
  const response = await fetch(`http://localhost:${app.address().port}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "ollama", message: "hello" }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "service_unavailable");
});

test("private Command routes serve the cockpit and stay loopback-only by default", async (t) => {
  setEnv(t, "NEBULA_EDITION", "command");
  const server = createServer().listen(0, "localhost");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  for (const route of ["overview", "jarvis", "studio", "knowledge", "research", "images", "jobs", "settings"]) {
    const page = await fetch(`${base}/command/${route}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Private Command/);
  }
  const status = await fetch(`${base}/api/command/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).edition, "command");
  const denied = await fetch(`${base}/api/command/status`, { headers: { origin: "https://attacker.invalid" } });
  assert.equal(denied.status, 403);
});

test("Command status adds Jarvis, search, embed, and GPU without changing legacy health", async (t) => {
  setEnv(t, "NEBULA_EDITION", "command");
  setEnv(t, "OLLAMA_URL", undefined);
  setEnv(t, "OPENAI_COMPATIBLE_URL", undefined);
  setEnv(t, "COMFYUI_URL", undefined);
  setEnv(t, "SEARXNG_URL", undefined);
  setEnv(t, "EMBED_MODEL", undefined);
  setEnv(t, "GPU_STATUS_URL", undefined);
  const server = createServer().listen(0, "localhost");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;

  const health = await fetch(`${base}/api/health`);
  assert.deepEqual(await health.json(), { status: "ok", version: "0.1.0" });

  const response = await fetch(`${base}/api/status`, { method: "POST" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.edition, "command");
  assert.deepEqual(
    Object.keys(result.services),
    ["database", "redis", "chat", "images", "jarvis", "search", "embed", "gpu"]
  );
  assert.equal(result.services.search.state, "disabled");
  assert.equal(result.services.embed.state, "disabled");
  assert.equal(result.services.gpu.state, "disabled");
});

test("Command health rejects 4xx search and a missing embedding model", async (t) => {
  const upstream = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "qwen3:8b" }] }));
    if (req.url?.startsWith("/search?")) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "json_disabled" }));
    }
    res.statusCode = 404;
    return res.end("{}");
  }).listen(0, "localhost");
  await new Promise((resolve) => upstream.once("listening", resolve));
  t.after(() => upstream.close());
  const endpoint = `http://localhost:${upstream.address().port}`;
  setEnv(t, "NEBULA_EDITION", "command");
  setEnv(t, "OLLAMA_URL", endpoint);
  setEnv(t, "OPENAI_COMPATIBLE_URL", undefined);
  setEnv(t, "COMFYUI_URL", undefined);
  setEnv(t, "SEARXNG_URL", endpoint);
  setEnv(t, "EMBED_MODEL", "nomic-embed-text");
  setEnv(t, "GPU_STATUS_URL", undefined);

  const server = createServer().listen(0, "localhost");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const response = await fetch(`http://localhost:${server.address().port}/api/status`, { method: "POST" });
  const result = await response.json();

  assert.equal(result.services.jarvis.state, "online");
  assert.equal(result.services.search.state, "degraded");
  assert.equal(result.services.embed.state, "degraded");
  assert.match(result.services.embed.detail, /not installed/);
});

test("private Command token is required when configured", async (t) => {
  setEnv(t, "NEBULA_EDITION", "command");
  const oldToken = process.env.COMMAND_ACCESS_TOKEN;
  process.env.COMMAND_ACCESS_TOKEN = "test-command-token";
  const server = createServer().listen(0, "localhost");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.close();
    if (oldToken === undefined) delete process.env.COMMAND_ACCESS_TOKEN; else process.env.COMMAND_ACCESS_TOKEN = oldToken;
  });
  const base = `http://localhost:${server.address().port}`;
  const denied = await fetch(`${base}/api/command/status`);
  assert.equal(denied.status, 401);
  const allowed = await fetch(`${base}/api/command/status`, { headers: { "x-command-token": "test-command-token" } });
  assert.equal(allowed.status, 200);
});

test("Jarvis uses the server-configured local Ollama endpoint", async (t) => {
  setEnv(t, "NEBULA_EDITION", "command");
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: { content: `Local echo: ${payload.messages.at(-1).content}` } }));
  }).listen(0, "localhost");
  const oldOllama = process.env.OLLAMA_URL;
  const server = createServer().listen(0, "localhost");
  await Promise.all([
    new Promise((resolve) => upstream.once("listening", resolve)),
    new Promise((resolve) => server.once("listening", resolve))
  ]);
  process.env.OLLAMA_URL = `http://localhost:${upstream.address().port}`;
  t.after(() => {
    upstream.close();
    server.close();
    if (oldOllama === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = oldOllama;
  });
  const response = await fetch(`http://localhost:${server.address().port}/api/jarvis/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello" })
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).message, { role: "assistant", content: "Local echo: hello" });
});

test("local research fails explicitly when SearXNG is not configured", async (t) => {
  setEnv(t, "NEBULA_EDITION", "command");
  const oldSearch = process.env.SEARXNG_URL;
  delete process.env.SEARXNG_URL;
  const server = createServer().listen(0, "localhost");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.close();
    if (oldSearch === undefined) delete process.env.SEARXNG_URL; else process.env.SEARXNG_URL = oldSearch;
  });
  const response = await fetch(`http://localhost:${server.address().port}/api/research?q=local`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "research_disabled");
});