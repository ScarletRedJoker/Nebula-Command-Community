import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../src/server.mjs";
import { inspectDiagnosticArchive } from "../src/core.mjs";

test("health and unknown routes have stable contracts", async (t) => {
  const server = createServer().listen(0, "localhost");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", version: "0.1.0" });
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