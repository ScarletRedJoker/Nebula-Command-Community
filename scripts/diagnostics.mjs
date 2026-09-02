import { writeFile } from "node:fs/promises";
import { diagnosticArchive } from "../src/core.mjs";
const output = `diagnostics-${new Date().toISOString().replaceAll(":", "-")}.json.gz`;
await writeFile(output, diagnosticArchive({
  generatedAt: new Date().toISOString(),
  version: "0.1.0",
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  configuration: {
    database: process.env.DATABASE_URL ? "configured" : "disabled",
    redis: process.env.REDIS_URL ? "configured" : "disabled",
    chat: process.env.OLLAMA_URL || process.env.OPENAI_COMPATIBLE_URL ? "configured" : "disabled",
    images: process.env.COMFYUI_URL ? "configured" : "disabled"
  },
  note: "This offline bundle never reads prompts, conversations, logs, headers, or environment values."
}));
console.log(output);