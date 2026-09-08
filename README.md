# posko-ai

Standalone OpenAI-compatible gateway in **Bun + TypeScript**.
Routes 26 free models from **OpenCode Zen** (7) + **KiloCode gateway** (19) behind one `BASE_URL` + one dummy `API_KEY`.
See `DESIGN.md` for architecture.

## Prerequisites

- `bun >= 1.4` (`bun --version`)
- No database, no API keys for upstreams (Kilo free tier is keyless; OpenCode Zen uses a built-in CLI identity header).

## Quickstart

```bash
cp .env.example .env   # optional — defaults already work
bun install
bun test               # 24 tests, no network needed
bun run dev            # http://127.0.0.1:47831
```

Connect any OpenAI client:

```text
BASE_URL = http://127.0.0.1:47831/v1
API_KEY  = sk-posko-local
```

```bash
curl $BASE_URL/models -H "Authorization: Bearer $API_KEY"
curl $BASE_URL/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.5-free","messages":[{"role":"user","content":"Reply with exactly OK."}]}'
```

## How to run

| Command | What it does | When to use |
|---|---|---|
| `bun run dev` | Starts with `--watch`, reloads on edit | Development |
| `bun start` | Starts once, no watch (`bun src/index.ts`) | Local serve / systemd / docker `CMD` |
| `PORT=5000 bun start` | Same, inline env overrides `.env` | Quick port/key override without editing files |
| `bun test` | Runs `test/*.test.ts` (pure + route-level, mocked upstream) | Before every commit |
| `bun run typecheck` | `tsc --noEmit` | CI / after refactors |
| `bun run build` | Compiles to `dist/posko-ai` single binary | Deploy without Bun installed: `./dist/posko-ai` |

Config is loaded at boot from environment (`.env` supported via Bun). The server binds `HOST:PORT`, runs a background health-check (10s timeout, fail-open), then serves.

```bash
# examples
HOST=127.0.0.1 PORT=47831 bun start
GATEWAY_API_KEY=sk-secret-123 bun start
LOG_LEVEL=debug bun run dev
```

Compiled binary usage:

```bash
bun run build
GATEWAY_API_KEY=sk-secret-123 ./dist/posko-ai
```

## Configuration — what each field does

All fields live in `.env.example` / environment. Invalid numbers fall back to defaults.

| Field | Default | What it does |
|---|---|---|
| `HOST` | `127.0.0.1` | Interface to bind. Keep `127.0.0.1` for local-only. Set `0.0.0.0` only if you intentionally expose to LAN (then definitely change `GATEWAY_API_KEY`). |
| `PORT` | `47831` | Listen port. Uncommon 5-digit to avoid clashing with `pi-bansos :18080`, `3000`, `8000`. Shown in `GET /` as `baseUrl`. |
| `GATEWAY_API_KEY` | `sk-posko-local` | The **single dummy key** clients send as `Authorization: Bearer <key>` on all `/v1/*`. Not an upstream key — just gates your local gateway. Change per machine/user. |
| `UPSTREAM_OPENCODE` | `https://opencode.ai/zen` | Base for OpenCode Zen (`/v1/chat/completions`, `/v1/responses`, `/v1/models`). Change only for mirrors/tests. |
| `UPSTREAM_KILO` | `https://api.kilo.ai/api/gateway` | Base for Kilo (`/chat/completions`, `/models`). Gateway always sends `Authorization: Bearer kilo-free`. |
| `RELAY_URL` | _(empty)_ | Optional egress worker URL (Vercel/Cloudflare). Empty = **direct mode** (recommended default). No built-in default on purpose — bring your own. |
| `RELAY_ENABLED` | `false` | `true` + non-empty `RELAY_URL` routes upstream calls through the relay (`x-relay-target`/`x-relay-path`). Use when your IP is rate-limited. Toggle live via `POST /v1/admin/relay` too. |
| `RATE_OPENCODE_DAY` | `200` | Local guard: max requests per UTC day per IP to OpenCode. Returns `429 rate_limit_exceeded`. Mirrors upstream free quota; prevents one process from flooding. |
| `RATE_KILO_HOUR` | `200` | Local guard: max requests per rolling hour per IP to Kilo (matches documented `200/hour/IP`). `429` when hit. |
| `MAX_IMAGE_MB` | `20` | Max **decoded** image bytes per `data:` URL. Checked by math (`len*3/4 - pad`, no alloc). Over → `400 image_too_large`, never forwarded. |
| `MAX_IMAGES_PER_MESSAGE` | `8` | Max `image_url`/`input_image` parts per message. Over → `400`. `https:` and `data:` share the counter. |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`. Structured `[posko-ai]` logs; boot prints listen line + `health-check: opencode=N kilo=M`. |
| `PROBE_TIMEOUT_MS` | `25000` | Per-model timeout for `POST /v1/admin/models/probe`. Timeout → `probe.ok:false, error:"probe timeout..."`. |
| `PROBE_CONCURRENCY` | `4` | How many models are probed in parallel. Higher = faster full run, burstier on quotas. |
| `PROBE_MAX_TOKENS` | `8` | `max_tokens` / `max_output_tokens` of the probe prompt — keep tiny to save quota. |

## Endpoints

| Method + path | Auth | Description |
|---|---|---|
| `GET /` | no | `{name, version, baseUrl, models:26, upstreams}` — self-describing root |
| `GET /health` | no | `{ok, upstreams:{opencode:{alive}, kilo:{alive}}, relay:{enabled,url}}` |
| `GET /v1/models` | yes | OpenAI `ListModels` from **alive** registry only (never proxies upstream, so paid models can't leak) |
| `POST /v1/chat/completions` | yes | Chat Completions, `stream:true/false`, text+image in, text out (SSE `data: [DONE]` when streaming) |
| `POST /v1/responses` | yes | Responses API — **only** for `muse-spark-1.3/1.2-contributor-free`; other models get `400` with chat hint |
| `GET /v1/admin/relay/status` | yes | Current `{enabled, url}` |
| `POST /v1/admin/relay` | yes | `{"enabled":true,"url":"https://..."}` — switch egress live, persisted to `~/.config/posko-ai/relay.json` |
| `GET /v1/admin/models/status` | yes | Per-model live status: catalog membership + last inference probe (`ok/latency/error/checkedAt`) + summary counts |
| `POST /v1/admin/models/probe` | yes | Trigger a live probe (tiny inference per model, `202` + background run; optional `{"models":["id",...]}` subset). Poll `GET .../status` |

Chat example (streaming):

```bash
curl -N $BASE_URL/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.5-free","stream":true,"messages":[{"role":"user","content":"hi"}]}'
# data: {"choices":[{"delta":{"content":"Hello"}}]} ... data: [DONE]
```

Image example (vision model only):

```bash
curl $BASE_URL/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.5-free","messages":[{"role":"user","content":[
    {"type":"text","text":"what is in this image?"},
    {"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgo="}}
  ]}]}'
```

Python SDK:

```python
from openai import OpenAI
c = OpenAI(base_url="http://127.0.0.1:47831/v1", api_key="sk-posko-local")
print(c.models.list().data[0].id)
print(c.chat.completions.create(model="mimo-v2.5-free",
      messages=[{"role": "user", "content": "hi"}]).choices[0].message.content)
```

## Image rules

- Accepted: `https://...` + `data:image/png|jpeg|webp;base64,...`. Rejected: `file://`, plain `http://`, `svg`/`gif`, malformed base64 (`%4==1`), oversize, 9th image in one message.
- Vision models (11): `muse-spark-1.3/1.2`, `mimo-v2.5`, `step-3.7-flash`, `dots-3-note`, `nemotron-3-nano-omni`, `openrouter/free`, `nemotron-3.5-content-safety`, `minimax-m3`, `inkling-small`, `inkling`. All others are text-only → image returns `400 vision_not_supported`.
- Size is computed as `floor(len*3/4) - padding` without decoding, so huge payloads are rejected cheaply.

## Relay (optional)

Default is direct (no relay). If rate-limited (`429`) or IP-blocked, point at your own worker and enable:

```bash
curl -X POST http://127.0.0.1:47831/v1/admin/relay \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"enabled":true,"url":"https://your-relay.vercel.app"}'
```

Back to direct: `{"enabled":false}`. State persists across restarts.

## Model status (live probe)

Boot health-check only proves catalog membership. To prove a model actually answers, trigger a probe — one tiny inference per model (`"Reply with exactly OK."`, `max_tokens: 8`):

```bash
# all models (background run, ~1 upstream request per model)
curl -X POST $BASE_URL/admin/models/probe -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" -d '{}'
# → {"ok":true,"started":true,"running":true,"targets":26}

# subset only (cheaper on quota)
curl -X POST $BASE_URL/admin/models/probe -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" -d '{"models":["kilo-auto/free","mimo-v2.5-free"]}'

# poll until running:false
curl $BASE_URL/admin/models/status -H "Authorization: Bearer $API_KEY"
# → {running, lastRunAt, summary:{total,ok,failed,unknown},
#    models:[{id, upstream, catalogAlive, vision, probe:{ok,latencyMs,checkedAt,statusCode,error}|null}]}
```

Notes: `409` means a probe is already running. Probes consume upstream quota (kilo 200/hr, opencode 200/day), so trigger on demand, not on an interval. Probe knobs: `PROBE_TIMEOUT_MS` (default 25000), `PROBE_CONCURRENCY` (default 4), `PROBE_MAX_TOKENS` (default 8). `/health` also carries a `probe` summary once a run has finished.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401 invalid_api_key` | Missing/wrong `Authorization: Bearer` — must equal `GATEWAY_API_KEY`. `/` and `/health` are the only public paths. |
| `404 model_not_found` | Typo, or model filtered by live health-check (see `/health` alive counts; e.g. kilo occasionally drops to 17/19). |
| `400 vision_not_supported` | Image sent to a text-only model — switch to one of the 11 vision models above. |
| `400 image_too_large` | Decoded image > `MAX_IMAGE_MB` — downscale or raise the limit. |
| `429 rate_limit_exceeded` | Local guard hit (`RATE_*`) or upstream quota — wait, or enable a relay for a fresh egress IP. |
| `502 upstream error` | Upstream down/timeout (300s cap). Check `/health`, retry. Streaming aborts mid-body just close (headers already sent). |
| Port in use | Change `PORT=` — the gateway does not auto-bump (unlike pi-bansos). |
