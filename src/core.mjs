import { gunzipSync, gzipSync } from "node:zlib";

const SECRET_KEYS = /authorization|api[-_]?key|token|secret|password|cookie/i;
const SECRET_VALUE = /(bearer\s+|sk-)[a-z0-9._-]+|-----BEGIN [A-Z ]+PRIVATE KEY-----/gi;
const PRIVATE_ADDRESS = /\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b192\.168\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/gi;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi;
const URL_SECRET_QUERY = /([?&](?:api[-_]?key|token|secret|password|authorization)=)[^&\s]+/gi;
const FILE_URL = /file:\/\/\/[^\s]*/gi;
const SENSITIVE_PATH = /\/(?:home|Users|private|var|tmp|opt|workspace)\/[^\s]*/g;

export function safeEndpoint(value, fallback) {
  const url = new URL(value || fallback);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Endpoint must use http or https");
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

export function redact(value, key = "", internalHosts = []) {
  if (SECRET_KEYS.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item, "", internalHosts));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k, internalHosts)]));
  }
  if (typeof value !== "string") return value;
  const withoutSecrets = value
    .replace(URL_CREDENTIALS, "$1[REDACTED]@")
    .replace(URL_SECRET_QUERY, "$1[REDACTED]")
    .replace(FILE_URL, "file://[REDACTED_PATH]")
    .replace(SECRET_VALUE, "[REDACTED]")
    .replace(PRIVATE_ADDRESS, "[PRIVATE_ADDRESS]")
    .replace(SENSITIVE_PATH, "[REDACTED_PATH]");
  return internalHosts.reduce((text, host) => host ? text.replaceAll(host, "[INTERNAL_HOST]") : text, withoutSecrets)
    .replace(/\b(?:fc|fd)[0-9a-f:]+\b/gi, "[PRIVATE_IPV6]")
    .replace(/\bfe80:[0-9a-f:]+\b/gi, "[LINK_LOCAL_IPV6]")
    .replace(/(?<![0-9a-f:])::1(?![0-9a-f:])/gi, "[LOOPBACK_IPV6]");
}

export function diagnosticArchive(report, internalHosts = []) {
  return gzipSync(JSON.stringify(redact(report, "", internalHosts), null, 2));
}

export function inspectDiagnosticArchive(buffer) {
  return JSON.parse(gunzipSync(buffer).toString("utf8"));
}

export function imageWorkflow(prompt, seed = 1) {
  return {
    "3": { class_type: "KSampler", inputs: { seed, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "nebula-community", images: ["8", 0] } }
  };
}

export function jsonError(code, message, status = 400) {
  return { status, body: { error: code, message } };
}