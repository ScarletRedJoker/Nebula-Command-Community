import assert from "node:assert/strict";
import http from "node:http";

delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.COMMAND_ACCESS_TOKEN;
process.env.NEBULA_EDITION = "command";
process.env.HOST = "127.0.0.1";
process.env.OLLAMA_URL = "http://mock-ollama.local";
process.env.SEARXNG_URL = "http://mock-searxng.local";
process.env.COMFYUI_URL = "http://mock-comfyui.local";

const outbound = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  outbound.push(url.href);

  if (url.hostname === "mock-ollama.local" && url.pathname === "/api/tags") {
    return Response.json({ models: [{ name: "qwen3:8b" }] });
  }
  if (url.hostname === "mock-searxng.local" && url.pathname === "/search") {
    return Response.json({ results: [] });
  }
  if (url.hostname === "mock-comfyui.local" && url.pathname === "/system_stats") {
    return Response.json({ devices: [] });
  }
  return Response.json({ error: "unexpected mocked upstream request" }, { status: 500 });
};

function request(server, path) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: "127.0.0.1",
      port: address.port,
      path,
      headers: { host: `127.0.0.1:${address.port}` }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
        headers: res.headers
      }));
    });
    req.on("error", reject);
  });
}

const { createServer } = await import("../src/server.mjs");
const server = createServer();

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const health = await request(server, "/api/health");
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).status, "ok");

  const commandPage = await request(server, "/command/");
  assert.equal(commandPage.status, 200);
  assert.match(commandPage.body, /Private Command/);

  const status = await request(server, "/api/command/status");
  assert.equal(status.status, 200);
  const statusBody = JSON.parse(status.body);
  assert.equal(statusBody.services.ollama.state, "online");
  assert.equal(statusBody.services.research.state, "online");
  assert.equal(statusBody.services.images.state, "online");
  assert.equal(statusBody.services.database.state, "disabled");

  assert.ok(outbound.some((url) => url.startsWith("http://mock-ollama.local/api/tags")));
  assert.ok(outbound.some((url) => url.startsWith("http://mock-searxng.local/search")));
  assert.ok(outbound.some((url) => url.startsWith("http://mock-comfyui.local/system_stats")));

  console.log("Mocked Command smoke passed.");
} finally {
  await new Promise((resolve) => server.close(resolve));
  globalThis.fetch = realFetch;
}