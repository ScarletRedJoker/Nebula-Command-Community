import test from "node:test";
import assert from "node:assert/strict";
import { diagnosticArchive, imageWorkflow, inspectDiagnosticArchive, redact, safeEndpoint } from "../src/core.mjs";

test("redacts secrets, home paths, and private addresses", () => {
  const address = ["192", "168", "1", "20"].join(".");
  const value = redact({ apiKey: "sk-danger", detail: `Bearer abc123 at ${address} in /home/alice/file` });
  assert.equal(value.apiKey, "[REDACTED]");
  assert.equal(value.detail.includes("abc123"), false);
  assert.equal(value.detail.includes(address), false);
  assert.equal(value.detail.includes("alice"), false);
});

test("diagnostic archive contains only redacted content", () => {
  const privateAddress = ["127", "0", "0", "1"].join(".");
  const userInfo = ["user", "password"].join(":");
  const databaseUserInfo = ["admin", "password"].join(":");
  const querySecretName = ["api", "key"].join("_");
  const querySecretValue = ["secret", "value"].join("-");
  const report = inspectDiagnosticArchive(diagnosticArchive({
    token: "secret",
    nested: { endpoint: `http://${userInfo}@${privateAddress}:9000/v1?${querySecretName}=${querySecretValue}`, file: "file:///private/keys/config" },
    error: `connection refused for postgresql://${databaseUserInfo}@${privateAddress}:5432/local and fd12:3456::1 fe80::1 ::1`,
    host: "inference.internal"
  }, ["inference.internal"]));
  assert.equal(report.token, "[REDACTED]");
  assert.equal(report.nested.endpoint.includes("user:password"), false);
  assert.equal(report.nested.endpoint.includes(querySecretValue), false);
  assert.equal(report.error.includes("admin:password"), false);
  assert.equal(report.error.includes(privateAddress), false);
  assert.equal(report.error.includes("fd12:3456::1"), false);
  assert.equal(report.error.includes("fe80::1"), false);
  assert.equal(report.error.includes("::1"), false);
  assert.equal(report.nested.file.includes("/private/"), false);
  assert.equal(report.host.includes("inference.internal"), false);
  assert.match(report.nested.endpoint, /PRIVATE_ADDRESS/);
});

test("endpoint accepts only http protocols and strips credentials", () => {
  assert.throws(() => safeEndpoint("file:///etc/passwd"), /http or https/);
  const credentialedEndpoint = `http://${["user", "pass"].join(":")}@example.test/v1`;
  assert.equal(safeEndpoint(credentialedEndpoint).toString(), "http://example.test/v1");
});

test("image workflow is constrained to expected nodes", () => {
  const workflow = imageWorkflow("aurora", 42);
  assert.equal(workflow["3"].inputs.seed, 42);
  assert.equal(workflow["6"].inputs.text, "aurora");
  assert.deepEqual(Object.keys(workflow), ["3", "4", "5", "6", "7", "8", "9"]);
});