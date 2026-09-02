# Nebula Command Community Edition

A compact, source-available, local-first web app for checking a local AI stack, chatting with an Ollama or OpenAI-compatible endpoint, and submitting constrained image jobs to ComfyUI.

> **Edition boundary:** This tree is intentionally independent from the private dashboard and Jarvis modules; private automation and commercial capabilities are not included.

## Quick start

Requirements: Docker with Compose, or Node.js 22+ and pnpm 10+.

```sh
cp .env.example .env
# Set POSTGRES_PASSWORD and review endpoint defaults.
docker compose up --build
```

Open `http://localhost:3000`. PostgreSQL creates the schema and seed on the first empty-volume start. Redis persistence is enabled. Local inference programs run on the host and are reached through `host.docker.internal`; configure their server-side endpoints in `.env`, not in the browser.

For direct Node use:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
set -a; . ./.env; set +a
pnpm start
```

PostgreSQL migrations can be applied directly with:

```sh
psql "$DATABASE_URL" -f migrations/001_initial.sql
psql "$DATABASE_URL" -f migrations/002_seed.sql
```

## Configuration

Inference destinations are configured only through `.env`: `OLLAMA_URL`, `OPENAI_COMPATIBLE_URL`, and `COMFYUI_URL`. Browser Settings select the chat provider/model only; no unauthenticated browser request can select an upstream destination. Provider/model preferences and the latest 40 chat messages are stored in browser local storage. API keys are session-only. Conversation and image-job history is also written to PostgreSQL when configured.

The health page makes failures explicit:

- `online`: the service responded.
- `disabled`: no endpoint or connection was configured.
- `offline` / `degraded`: the service was configured but did not respond correctly.

ComfyUI must have a checkpoint named `model.safetensors`, or the submitted job will fail visibly in ComfyUI. The Community app submits a fixed 512×512 text-to-image workflow and returns the local and remote job IDs.

## Diagnostics

Use **Status → Download redacted bundle**, or run:

```sh
pnpm diagnostics
```

Bundles are gzipped JSON. They omit prompts, conversations, cookies, authorization headers, service logs, and raw environment values. The web bundle probes current service health and redacts credential-shaped fields, home paths, and private network addresses.

## Development

```sh
pnpm test
pnpm typecheck
pnpm build
```

Every public commit is independently checked on GitHub Actions. The required
`Build, test, and audit` job installs from the frozen lockfile, runs the commands
above, audits production dependencies, and validates the Compose configuration.
The required `Fresh migration smoke` job also applies both migrations to an
empty PostgreSQL database and verifies the expected schema and seed data. A
failed required check blocks the next generated update: the publisher verifies
both checks on the current public commit before creating its successor.

The runtime uses only Node's HTTP server and `pg`; it has no dependency on another source tree. See [SUPPORT.md](SUPPORT.md) before filing an issue and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## License

Source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE). Commercial operation, managed hosting, paid bundling, resale, and commercial redistribution require a separate agreement. Third-party models and services retain their own terms.