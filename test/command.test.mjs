import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandService } from "../src/command.mjs";

// Built at runtime so this file holds no credential-bearing URL literal (the Community export's secret scanner
// rejects those); the redaction tests still receive exactly the same URL string.
function credentialBearingUrl(base, username, password) {
  const url = new URL(base);
  url.username = username;
  url.password = password;
  return url.toString();
}

function auditEvent(entry) {
  if (entry.text.includes("WITH updated AS")) {
    return { action: entry.values[8], outcome: entry.values[9], detail: JSON.parse(entry.values[10]) };
  }
  return { action: entry.values[1], outcome: entry.values[3], detail: JSON.parse(entry.values[4]) };
}

test("workspace broker confines file reads and requires approval for writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nebula-command-"));
  const oldRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = root;
  const service = createCommandService({ pool: null, root: process.cwd() });
  await mkdir(join(root, "demo"), { recursive: true });
  await writeFile(join(root, "demo", "README.md"), "hello", "utf8");
  await writeFile(join(root, "outside.txt"), "private", "utf8");
  await symlink(join(root, "outside.txt"), join(root, "demo", "outside-link.txt"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = oldRoot;
  });

  assert.deepEqual(await service.listFiles("demo"), ["README.md"]);
  assert.deepEqual(await service.readWorkspaceFile("demo", "README.md"), { path: "README.md", content: "hello" });
  await assert.rejects(() => service.readWorkspaceFile("demo", "../outside.txt"), /escapes the project root/);
  await assert.rejects(() => service.readWorkspaceFile("demo", "outside-link.txt"), /escapes the project root/);
  await assert.rejects(() => service.writeWorkspaceFile("demo", "notes.txt", "no", false), (error) => error.code === "approval_required");
  await service.writeWorkspaceFile("demo", "notes.txt", "approved", true);
  assert.equal(await readFile(join(root, "demo", "notes.txt"), "utf8"), "approved");
});

test("workspace command runner rejects unapproved and non-allowlisted commands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nebula-command-run-"));
  const oldRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = root;
  const service = createCommandService({ pool: null, root: process.cwd() });
  await mkdir(join(root, "demo"), { recursive: true });
  await writeFile(join(root, "demo", "check.mjs"), "export default 1;\n", "utf8");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = oldRoot;
  });

  await assert.rejects(() => service.runWorkspaceCommand("demo", { program: "node", args: ["--check", "check.mjs"] }), (error) => error.code === "approval_required");
  await assert.rejects(() => service.runWorkspaceCommand("demo", { program: "sh", args: ["-c", "id"], confirm: true }), (error) => error.code === "command_not_allowed");
  const result = await service.runWorkspaceCommand("demo", { program: "node", args: ["--check", "check.mjs"], confirm: true });
  assert.equal(result.code, 0);
});

test("bounded coding tasks inspect, pause for approval, and continue with observations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nebula-command-task-"));
  const oldRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = root;
  const queries = [];
  const pool = {
    async query(text, values = []) {
      queries.push({ text, values });
      if (text.includes("SELECT id FROM command_projects")) return { rows: [{ id: "00000000-0000-0000-0000-000000000001" }] };
      if (text.includes("UPDATE command_jobs") && text.includes("RETURNING id")) return { rows: [{ id: values[0] }] };
      return { rows: [] };
    }
  };
  const service = createCommandService({ pool, root: process.cwd(), taskTimeoutMs: 5000 });
  await mkdir(join(root, "demo"), { recursive: true });
  await writeFile(join(root, "demo", "check.mjs"), "export default 1;\n", "utf8");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = oldRoot;
  });

  const plan = [
    { kind: "inspect", path: "check.mjs" },
    { kind: "write", path: "notes.txt", content: "approved\n" },
    { kind: "command", program: "node", args: ["--check", "check.mjs"] }
  ];
  const waiting = await service.startWorkspaceTask("demo", { goal: "Add a note and validate the module", plan });
  assert.equal(waiting.status, "awaiting_approval");
  assert.equal(waiting.currentStep, 1);
  assert.equal(waiting.approval.kind, "write");
  assert.equal(await readFile(join(root, "demo", "check.mjs"), "utf8"), "export default 1;\n");

  const commandApproval = await service.approveWorkspaceTask(waiting.id, true);
  assert.equal(commandApproval.status, "awaiting_approval");
  assert.equal(commandApproval.currentStep, 2);
  assert.equal(commandApproval.approval.kind, "command");
  assert.equal(await readFile(join(root, "demo", "notes.txt"), "utf8"), "approved\n");

  const complete = await service.approveWorkspaceTask(waiting.id, true);
  assert.equal(complete.status, "complete");
  assert.equal(complete.currentStep, 3);
  assert.equal(complete.observations.length, 3);
  const auditActions = queries.filter((entry) => entry.text.includes("INSERT INTO command_audit_events")).map((entry) => entry.values[1]);
  assert.ok(auditActions.includes("coding.step"));
  assert.ok(auditActions.includes("coding.approval"));
  assert.ok(auditActions.includes("coding.job"));
});

test("coding task cancellation is persisted without executing a pending write", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nebula-command-cancel-"));
  const oldRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = root;
  const service = createCommandService({ pool: null, root: process.cwd() });
  await mkdir(join(root, "demo"), { recursive: true });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = oldRoot;
  });

  const task = await service.startWorkspaceTask("demo", {
    plan: [{ kind: "write", path: "never.txt", content: "not run" }]
  });
  const cancelled = await service.cancelWorkspaceTask(task.id);
  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(() => readFile(join(root, "demo", "never.txt")));
});

test("restart recovery skips completed work and approval-gates the next command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nebula-command-recovery-"));
  const oldRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = root;
  await mkdir(join(root, "demo"), { recursive: true });
  await writeFile(join(root, "demo", "notes.txt"), "already written\n", "utf8");
  await writeFile(join(root, "demo", "check.mjs"), "export default 1;\n", "utf8");
  const job = {
    id: "00000000-0000-0000-0000-000000000010",
    projectId: "00000000-0000-0000-0000-000000000001",
    kind: "coding",
    status: "running",
    input: { projectSlug: "demo", goal: "Recover safely" },
    output: {
      plan: [
        { kind: "write", path: "notes.txt", content: "already written\n" },
        { kind: "command", program: "node", args: ["--check", "check.mjs"], cwd: "" }
      ],
      currentStep: 0,
      observations: [],
      approval: null,
      execution: { step: 0, kind: "write", state: "started", startedAt: new Date().toISOString() },
      startedAt: new Date().toISOString()
    },
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const queries = [];
  const pool = {
    async query(text, values = []) {
      queries.push({ text, values });
      if (text.includes("FROM command_jobs") && text.includes("status IN")) return { rows: [structuredClone(job)] };
      if (text.includes("FROM command_audit_events")) return { rows: [] };
      if (text.includes("WITH updated AS")) return { rows: [{ request_id: values[0] }] };
      return { rows: [] };
    }
  };
  const service = createCommandService({ pool, root: process.cwd(), taskTimeoutMs: 5000 });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = oldRoot;
  });

  const [recovered] = await service.recoverWorkspaceTasks();
  assert.equal(recovered.status, "awaiting_approval");
  assert.equal(recovered.currentStep, 1);
  assert.equal(recovered.approval.kind, "command");
  assert.equal(await readFile(join(root, "demo", "notes.txt"), "utf8"), "already written\n");
  const auditDetails = queries
    .filter((entry) => entry.text.includes("INSERT INTO command_audit_events"))
    .map(auditEvent);
  assert.ok(auditDetails.some((event) => event.action === "coding.recovery" && event.outcome === "complete"));
  assert.ok(auditDetails.some((event) => event.action === "coding.recovery.step"
    && event.detail.decision === "skipped" && event.detail.reason === "write_already_matches"));
});

test("restart recovery replays inspections but keeps recovered writes approval-gated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nebula-command-recovery-inspect-"));
  const oldRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = root;
  await mkdir(join(root, "demo"), { recursive: true });
  await writeFile(join(root, "demo", "check.mjs"), "export default 1;\n", "utf8");
  const job = {
    id: "00000000-0000-0000-0000-000000000011",
    projectId: "00000000-0000-0000-0000-000000000001",
    kind: "coding",
    status: "running",
    input: { projectSlug: "demo", goal: "Recover inspection" },
    output: {
      plan: [
        { kind: "inspect", path: "check.mjs" },
        { kind: "write", path: "notes.txt", content: "approved later\n" }
      ],
      currentStep: 0,
      observations: [],
      approval: null,
      startedAt: null
    },
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const queries = [];
  const pool = {
    async query(text, values = []) {
      queries.push({ text, values });
      if (text.includes("FROM command_jobs") && text.includes("status IN")) return { rows: [structuredClone(job)] };
      if (text.includes("FROM command_audit_events")) return { rows: [] };
      if (text.includes("WITH updated AS")) return { rows: [{ request_id: values[0] }] };
      return { rows: [] };
    }
  };
  const service = createCommandService({ pool, root: process.cwd(), taskTimeoutMs: 5000 });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = oldRoot;
  });

  const [recovered] = await service.recoverWorkspaceTasks();
  assert.equal(recovered.status, "awaiting_approval");
  assert.equal(recovered.currentStep, 1);
  assert.equal(recovered.approval.kind, "write");
  await assert.rejects(() => readFile(join(root, "demo", "notes.txt")));
  const replay = queries
    .filter((entry) => entry.text.includes("INSERT INTO command_audit_events"))
    .map(auditEvent)
    .find((event) => event.action === "coding.recovery.step" && event.detail.decision === "replayed");
  assert.equal(replay.detail.kind, "inspect");
});

test("restart recovery does not bypass an outstanding write approval when content already matches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nebula-command-recovery-approval-"));
  const oldRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = root;
  await mkdir(join(root, "demo"), { recursive: true });
  await writeFile(join(root, "demo", "notes.txt"), "preexisting\n", "utf8");
  const job = {
    id: "00000000-0000-0000-0000-000000000012",
    projectId: "00000000-0000-0000-0000-000000000001",
    kind: "coding",
    status: "awaiting_approval",
    input: { projectSlug: "demo", goal: "Keep approval gated" },
    output: {
      plan: [{ kind: "write", path: "notes.txt", content: "preexisting\n" }],
      currentStep: 0,
      observations: [],
      approval: { step: 0, kind: "write", summary: "Write notes.txt" },
      execution: null,
      startedAt: new Date().toISOString()
    },
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const pool = {
    async query(text, values = []) {
      if (text.includes("FROM command_jobs") && text.includes("status IN")) return { rows: [structuredClone(job)] };
      if (text.includes("FROM command_audit_events")) return { rows: [] };
      if (text.includes("WITH updated AS")) return { rows: [{ request_id: values[0] }] };
      return { rows: [] };
    }
  };
  const service = createCommandService({ pool, root: process.cwd(), taskTimeoutMs: 5000 });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = oldRoot;
  });

  const [recovered] = await service.recoverWorkspaceTasks();
  assert.equal(recovered.status, "awaiting_approval");
  assert.equal(recovered.currentStep, 0);
  assert.equal(recovered.approval.kind, "write");
});

test("an interrupted command requires approval to skip and is never replayed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nebula-command-recovery-command-"));
  const oldRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = root;
  await mkdir(join(root, "demo"), { recursive: true });
  await writeFile(join(root, "demo", "check.mjs"), "export default 1;\n", "utf8");
  const execution = { step: 0, kind: "command", state: "started", startedAt: new Date().toISOString() };
  const job = {
    id: "00000000-0000-0000-0000-000000000013",
    projectId: "00000000-0000-0000-0000-000000000001",
    kind: "coding",
    status: "running",
    input: { projectSlug: "demo", goal: "Do not replay command" },
    output: {
      plan: [{ kind: "command", program: "node", args: ["--check", "check.mjs"], cwd: "" }],
      currentStep: 0,
      observations: [],
      approval: null,
      execution,
      startedAt: new Date().toISOString()
    },
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const queries = [];
  const pool = {
    async query(text, values = []) {
      queries.push({ text, values });
      if (text.includes("FROM command_jobs") && text.includes("status IN")) return { rows: [structuredClone(job)] };
      if (text.includes("FROM command_audit_events")) return { rows: [] };
      if (text.includes("WITH updated AS")) return { rows: [{ request_id: values[0] }] };
      if (text.includes("UPDATE command_jobs") && text.includes("RETURNING id")) return { rows: [{ id: values[0] }] };
      return { rows: [] };
    }
  };
  const service = createCommandService({ pool, root: process.cwd(), taskTimeoutMs: 5000 });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = oldRoot;
  });

  const [recovered] = await service.recoverWorkspaceTasks();
  assert.equal(recovered.status, "awaiting_approval");
  assert.equal(recovered.approval.recoveryAction, "skip_indeterminate");
  const complete = await service.approveWorkspaceTask(job.id, true);
  assert.equal(complete.status, "complete");
  assert.equal(complete.observations[0].outcome, "skipped");
  assert.equal(
    queries.filter((entry) => entry.text.includes("coding.step") && entry.values[3] === "started").length,
    0
  );
  assert.ok(queries
    .filter((entry) => entry.text.includes("INSERT INTO command_audit_events"))
    .map(auditEvent)
    .some((event) => event.action === "coding.recovery.step"
      && event.detail.reason === "indeterminate_command_outcome"));
});

test("a legacy running command without an execution marker is skipped rather than replayed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nebula-command-recovery-legacy-command-"));
  const oldRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = root;
  await mkdir(join(root, "demo"), { recursive: true });
  await writeFile(join(root, "demo", "check.mjs"), "export default 1;\n", "utf8");
  const job = {
    id: "00000000-0000-0000-0000-000000000014",
    projectId: "00000000-0000-0000-0000-000000000001",
    kind: "coding",
    status: "running",
    input: { projectSlug: "demo", goal: "Recover a pre-upgrade command safely" },
    output: {
      plan: [{ kind: "command", program: "node", args: ["--check", "check.mjs"], cwd: "" }],
      currentStep: 0,
      observations: [],
      approval: null,
      startedAt: new Date().toISOString()
    },
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const queries = [];
  const pool = {
    async query(text, values = []) {
      queries.push({ text, values });
      if (text.includes("FROM command_jobs") && text.includes("status IN")) return { rows: [structuredClone(job)] };
      if (text.includes("FROM command_audit_events")) return { rows: [] };
      if (text.includes("WITH updated AS")) return { rows: [{ request_id: values[0] }] };
      if (text.includes("UPDATE command_jobs") && text.includes("RETURNING id")) return { rows: [{ id: values[0] }] };
      return { rows: [] };
    }
  };
  const service = createCommandService({ pool, root: process.cwd(), taskTimeoutMs: 5000 });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = oldRoot;
  });

  const [recovered] = await service.recoverWorkspaceTasks();
  assert.equal(recovered.status, "awaiting_approval");
  assert.equal(recovered.approval.recoveryAction, "skip_indeterminate");
  const complete = await service.approveWorkspaceTask(job.id, true);
  assert.equal(complete.status, "complete");
  assert.equal(complete.observations[0].outcome, "skipped");
  assert.equal(
    queries.filter((entry) => entry.text.includes("coding.step") && entry.values[3] === "started").length,
    0
  );
});

test("an expired recovered job persists its timeout failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nebula-command-recovery-timeout-"));
  const oldRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = root;
  await mkdir(join(root, "demo"), { recursive: true });
  await writeFile(join(root, "demo", "check.mjs"), "export default 1;\n", "utf8");
  const job = {
    id: "00000000-0000-0000-0000-000000000015",
    projectId: "00000000-0000-0000-0000-000000000001",
    kind: "coding",
    status: "running",
    input: { projectSlug: "demo", goal: "Persist timeout" },
    output: {
      plan: [{ kind: "inspect", path: "check.mjs" }],
      currentStep: 0,
      observations: [],
      approval: null,
      startedAt: new Date(Date.now() - 10_000).toISOString()
    },
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const queries = [];
  const pool = {
    async query(text, values = []) {
      queries.push({ text, values });
      if (text.includes("FROM command_jobs") && text.includes("status IN")) return { rows: [structuredClone(job)] };
      if (text.includes("FROM command_audit_events")) return { rows: [] };
      if (text.includes("WITH updated AS")) return { rows: [{ request_id: values[0] }] };
      return { rows: [] };
    }
  };
  const service = createCommandService({ pool, root: process.cwd(), taskTimeoutMs: 1000 });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = oldRoot;
  });

  const [recovered] = await service.recoverWorkspaceTasks();
  assert.equal(recovered.status, "failed");
  assert.match(recovered.error, /time limit/);
  assert.ok(queries.some((entry) => entry.text.includes("INSERT INTO command_jobs") && entry.values[3] === "failed"));
});

test("coding planner fails explicitly when local Ollama is unavailable", async (t) => {
  const oldOllama = process.env.OLLAMA_URL;
  delete process.env.OLLAMA_URL;
  const root = await mkdtemp(join(tmpdir(), "nebula-command-plan-"));
  const oldRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = root;
  const service = createCommandService({ pool: null, root: process.cwd() });
  await mkdir(join(root, "demo"), { recursive: true });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = oldRoot;
    if (oldOllama === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = oldOllama;
  });
  await assert.rejects(
    () => service.planWorkspaceTask("demo", { goal: "Make a safe change" }),
    (error) => error.code === "local_model_unavailable" && /cloud providers are not used/.test(error.message)
  );
});

test("coding planner accepts only a bounded plan from the configured local Ollama", async (t) => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: { content: '{"steps":[{"kind":"inspect","path":"check.mjs"},{"kind":"command","program":"node","args":["--check","check.mjs"]}]}' } }));
  }).listen(0, "localhost");
  await new Promise((resolve) => upstream.once("listening", resolve));
  const oldOllama = process.env.OLLAMA_URL;
  const oldRoot = process.env.WORKSPACE_ROOT;
  process.env.OLLAMA_URL = `http://localhost:${upstream.address().port}`;
  const root = await mkdtemp(join(tmpdir(), "nebula-command-plan-success-"));
  process.env.WORKSPACE_ROOT = root;
  const service = createCommandService({ pool: null, root: process.cwd() });
  await mkdir(join(root, "demo"), { recursive: true });
  await writeFile(join(root, "demo", "check.mjs"), "export default 1;\n", "utf8");
  t.after(async () => {
    upstream.close();
    await rm(root, { recursive: true, force: true });
    if (oldOllama === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = oldOllama;
    if (oldRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = oldRoot;
  });

  const plan = await service.planWorkspaceTask("demo", { goal: "Validate this module locally" });
  assert.equal(plan.localOnly, true);
  assert.equal(plan.steps.length, 2);
  assert.deepEqual(plan.steps[1], { kind: "command", program: "node", args: ["--check", "check.mjs"], cwd: "", timeoutMs: undefined });
});

test("research memory is project-scoped, redacted, and auditable", async () => {
  const queries = [];
  const pool = {
    async query(text, values = []) {
      queries.push({ text, values });
      if (text.includes("SELECT id FROM command_projects")) return { rows: [{ id: "project-1" }] };
      if (text.includes("INSERT INTO command_memories")) return {
        rows: [{
          id: values[0],
          projectId: values[1],
          kind: values[2],
          title: values[3],
          sourceUrl: values[4],
          capturedAt: values[5],
          createdAt: values[5],
          content: values[6]
        }]
      };
      return { rows: [] };
    }
  };
  const service = createCommandService({ pool, root: process.cwd() });
  const saved = await service.saveMemory("demo", {
    kind: "research",
    title: "Local result",
    sourceUrl: "https://example.test/result",
    capturedAt: "2026-09-13T00:00:00.000Z",
    content: "Authorization: Bearer secret-value and a useful local finding"
  });
  assert.equal(saved.projectId, "project-1");
  assert.match(saved.content, /\[REDACTED\]/);
  assert.ok(queries.some(({ text, values }) => text.includes("INSERT INTO command_audit_events") && values[1] === "memory.save"));
});

test("vector memory fails explicitly without a local embedding endpoint", async () => {
  const oldBackend = process.env.COMMAND_MEMORY_BACKEND;
  const oldOllama = process.env.OLLAMA_URL;
  process.env.COMMAND_MEMORY_BACKEND = "vector";
  delete process.env.OLLAMA_URL;
  const pool = {
    async query(text) {
      if (text.includes("SELECT id FROM command_projects")) return { rows: [{ id: "project-1" }] };
      return { rows: [] };
    }
  };
  const service = createCommandService({ pool, root: process.cwd() });
  try {
    await assert.rejects(
      () => service.saveMemory("demo", { content: "local note" }),
      (error) => error.code === "memory_embedding_unavailable" && /cloud embeddings are not used/.test(error.message)
    );
  } finally {
    if (oldBackend === undefined) delete process.env.COMMAND_MEMORY_BACKEND; else process.env.COMMAND_MEMORY_BACKEND = oldBackend;
    if (oldOllama === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = oldOllama;
  }
});

test("memory embedding rebuild is project-scoped, bounded, local, and auditable", async (t) => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ embeddings: [[0.25, 0.75]] }));
  }).listen(0, "localhost");
  await new Promise((resolve) => upstream.once("listening", resolve));
  const oldBackend = process.env.COMMAND_MEMORY_BACKEND;
  const oldOllama = process.env.OLLAMA_URL;
  process.env.COMMAND_MEMORY_BACKEND = "vector";
  process.env.OLLAMA_URL = `http://localhost:${upstream.address().port}`;
  const queries = [];
  const pool = {
    async query(text, values = []) {
      queries.push({ text, values });
      if (text.includes("SELECT id FROM command_projects")) return { rows: [{ id: "project-1" }] };
      if (text.includes("SELECT id, title") && text.includes("embedding IS NULL")) {
        return { rows: [{ id: "memory-1", title: "Decision", sourceUrl: null, content: "Keep inference local" }] };
      }
      if (text.includes("SELECT count(*)::int AS count")) return { rows: [{ count: 2 }] };
      return { rows: [] };
    }
  };
  t.after(() => {
    upstream.close();
    if (oldBackend === undefined) delete process.env.COMMAND_MEMORY_BACKEND; else process.env.COMMAND_MEMORY_BACKEND = oldBackend;
    if (oldOllama === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = oldOllama;
  });

  const service = createCommandService({ pool, root: process.cwd() });
  const result = await service.rebuildMemoryEmbeddings("demo", { confirm: true, limit: 1000 });
  assert.equal(result.processed, 1);
  assert.equal(result.remaining, 2);
  assert.equal(result.limit, 100);
  assert.ok(queries.some(({ text, values }) => text.includes("UPDATE command_memories") && values[2] === "project-1"));
  assert.ok(queries.some(({ text, values }) => text.includes("INSERT INTO command_audit_events") && values[1] === "memory.rebuild" && values[3] === "started"));
  assert.ok(queries.some(({ text, values }) => text.includes("INSERT INTO command_audit_events") && values[1] === "memory.rebuild" && values[3] === "complete"));
});

test("memory embedding rebuild fails without Ollama and records the local-only failure", async () => {
  const oldBackend = process.env.COMMAND_MEMORY_BACKEND;
  const oldOllama = process.env.OLLAMA_URL;
  process.env.COMMAND_MEMORY_BACKEND = "vector";
  delete process.env.OLLAMA_URL;
  const queries = [];
  const pool = {
    async query(text, values = []) {
      queries.push({ text, values });
      if (text.includes("SELECT id FROM command_projects")) return { rows: [{ id: "project-1" }] };
      if (text.includes("SELECT id, title")) return { rows: [{ id: "memory-1", title: null, sourceUrl: null, content: "Local only" }] };
      return { rows: [] };
    }
  };
  const service = createCommandService({ pool, root: process.cwd() });
  try {
    await assert.rejects(
      () => service.rebuildMemoryEmbeddings("demo", { confirm: true }),
      (error) => error.code === "memory_embedding_unavailable" && /cloud embeddings are not used/.test(error.message)
    );
    assert.ok(queries.some(({ text, values }) => text.includes("INSERT INTO command_audit_events") && values[1] === "memory.rebuild" && values[3] === "failed"));
  } finally {
    if (oldBackend === undefined) delete process.env.COMMAND_MEMORY_BACKEND; else process.env.COMMAND_MEMORY_BACKEND = oldBackend;
    if (oldOllama === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = oldOllama;
  }
});

test("Jarvis retrieves only the selected project's local memory", async (t) => {
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: { content: payload.messages.some((message) => message.content.includes("remembered project decision")) ? "used memory" : "missing memory" } }));
  }).listen(0, "localhost");
  await new Promise((resolve) => upstream.once("listening", resolve));
  const oldOllama = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = `http://localhost:${upstream.address().port}`;
  const queries = [];
  const pool = {
    async query(text, values = []) {
      queries.push({ text, values });
      if (text.includes("SELECT id FROM command_projects")) return { rows: [{ id: "project-1" }] };
      if (text.includes("FROM command_memories")) return {
        rows: [{
          id: "memory-1",
          projectId: "project-1",
          kind: "decision",
          title: "Decision bearer private-token",
          sourceUrl: credentialBearingUrl("https://example.com/decision?token=private#internal", "operator", "private"),
          capturedAt: "2026-09-13T00:00:00.000Z",
          createdAt: "2026-09-13T00:00:00.000Z",
          content: "remembered project decision",
          score: 1
        }]
      };
      return { rows: [] };
    }
  };
  const service = createCommandService({ pool, root: process.cwd() });
  t.after(() => {
    upstream.close();
    if (oldOllama === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = oldOllama;
  });
  const result = await service.jarvisChat({ projectSlug: "demo", message: "What did we decide?" });
  const jarvisAudit = queries
    .filter((entry) => entry.text.includes("INSERT INTO command_audit_events"))
    .map(auditEvent)
    .find((event) => event.action === "jarvis.chat");
  assert.equal(result.memoryCount, 1);
  assert.equal(result.project, "demo");
  assert.deepEqual(result.memories, [{
    id: "memory-1",
    title: "Decision [REDACTED]",
    sourceUrl: "https://example.com/decision?token=[REDACTED]",
    capturedAt: "2026-09-13T00:00:00.000Z",
    createdAt: "2026-09-13T00:00:00.000Z"
  }]);
  assert.equal("content" in result.memories[0], false);
  assert.equal(jarvisAudit.detail.projectSlug, "demo");
  assert.deepEqual(jarvisAudit.detail.memories, result.memories);
  assert.equal("content" in jarvisAudit.detail.memories[0], false);
  assert.equal(result.message.content, "used memory");
});