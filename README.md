# BetterDB Playground Chat

[![CI](https://github.com/betterdb/playground-chat/actions/workflows/ci.yml/badge.svg)](./.github/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Open-source RAG chatbot grounded in **Valkey** and **Redis OSS** documentation.
Built as a runnable example of how
[`@betterdb/agent-cache`](https://www.npmjs.com/package/@betterdb/agent-cache)
(tool-result + LLM response caching) and
[`@betterdb/semantic-cache`](https://www.npmjs.com/package/@betterdb/semantic-cache)
(vector-similarity LLM caching) work together against a real workload, with a
metrics side-panel showing cache hits, embedding latency, and dollars saved per
turn.

```
┌──────────────────────────────────────────┬──────────────────────────┐
│  BetterDB Playground                     │  Cache Metrics           │
│  Valkey & Redis OSS docs · RAG demo      │                          │
│                                          │  All-time                │
│  [User] What is XADD?                    │  ┌──────┬──────┬──────┐ │
│  [Bot]  XADD appends entries to a        │  │14,2k │$42.2 │ 71%  │ │
│         stream...                        │  │ msgs │saved │  HR  │ │
│         Source: https://valkey.io/...    │  └──────┴──────┴──────┘ │
│                                          │                          │
│  [User] How about XREAD?                 │  This session            │
│  [Bot] (cached - returned instantly)     │  Turn 3                  │
│                                          │  Semantic cache  HIT     │
│  ┌────────────────────────────────────┐  │    sim=0.04 · saved      │
│  │  Ask about Valkey or Redis…   Send │  │    $0.0011               │
│  └────────────────────────────────────┘  │  Saved this turn:$0.0011 │
└──────────────────────────────────────────┴──────────────────────────┘
```

## Status

This is an **example / demo** project, deliberately small and forkable. It's
not intended as production middleware - the security, observability, and ops
features it ships with (TLS guidance, atomic rate limiter, IP hashing, OpenAI
moderation) are there because a public-facing demo needs them, not because
they're complete by enterprise standards. Take what's useful.

## Stack

| Layer          | Technology                                                    |
| -------------- | ------------------------------------------------------------- |
| Framework      | Next.js 15 App Router · React 19 · TypeScript (strict)        |
| LLM            | `gpt-4o-mini` by default · Vercel AI SDK v6                   |
| Embeddings     | `text-embedding-3-small` (1536d) · OpenAI                     |
| Tool/LLM cache | `@betterdb/agent-cache` (exact match, Valkey-backed)          |
| Semantic cache | `@betterdb/semantic-cache` (vector similarity, valkey-search) |
| Vector DB      | Valkey 8.1 + `valkey-search` module (HNSW, cosine distance)   |
| Rate limit     | Per-IP sliding window via atomic Lua on Valkey                |
| Budget gate    | Per-day USD kill-switch via atomic Lua                        |
| Logging        | Hashed-IP, scrubbed, persisted to a Valkey Stream             |

## Quick start

```bash
# 1. Bring up Valkey (with valkey-search, valkey-bloom, etc.)
docker compose up -d

# 2. Install
pnpm install

# 3. Configure env
cp .env.example .env
# fill in OPENAI_API_KEY at minimum

# 4. One-time: build the doc index
pnpm ingest          # crawls valkey.io + redis.io (polite, ~1 min)
pnpm build:index     # embeds + upserts into valkey-search
pnpm seed            # pre-warm the semantic cache from data/faq.jsonl

# 5. Run
pnpm dev
# open http://localhost:3000
```

## Architecture

```
Browser
  │
  ▼
Next.js App Router
  │
  ├── GET  /api/health   → Valkey PING + index existence + key presence
  ├── GET  /api/stats    → Aggregated counters (msgs, hits, $ saved)
  └── POST /api/chat
        │
        ├─ 1. validateEnv (fail-fast on misconfig)
        ├─ 2. Sync guardrails (length, control chars, type)
        ├─ 3. Async guardrails (OpenAI Moderation, opt-in)
        ├─ 4. Atomic rate limit (Lua sliding window, hour + day)
        ├─ 5. Semantic cache check
        │      HIT → stream cached response · report `costSaved` from cache
        │      MISS ↓
        ├─ 6. Atomic budget reservation (kill-switch on daily limit)
        ├─ 7. streamText() w/ AgentCache middleware
        │      └── Tools (each wrapped by agent-cache tool tier)
        │           ├── search_docs      (vector KNN)
        │           ├── get_command_ref  (FT.SEARCH exact)
        │           ├── compare_commands (cross-source)
        │           └── get_module_info  (vector KNN)
        ├─ 8. semanticCache.store(prompt, text, { model, inputTokens, outputTokens })
        ├─ 9. Settle budget reservation against actual cost
        └─ 10. Log turn (hashed IP, scrubbed query, costs, hits)
```

### How "cost saved" is calculated

There's no fabrication step in `/api/chat`:

- When the route stores a response in `semanticCache`, it passes the actual
  `model`, `inputTokens`, and `outputTokens` from the OpenAI usage report.
  The cache package computes and stores the cost.
- On a future hit, `semanticCache.check()` returns `costSaved` directly - the
  exact dollars the user would have spent on the LLM call we avoided.
- Tool-result cache savings are tracked internally by `agent-cache` and read
  via `agentCache.stats().costSavedMicros` from `/api/stats`.

The pricing table lives in `lib/pricing.ts` and is passed to both cache
packages so the per-package and per-route numbers don't drift.

## Environment

See [`.env.example`](./.env.example) for all variables and inline deploy notes.
The most important ones:

| Variable              | Default                  | Notes                                                                    |
| --------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `OPENAI_API_KEY`      | -                        | **Required.** Validated at startup.                                      |
| `VALKEY_URL`          | `redis://localhost:6399` | Use `rediss://` for any internet-exposed endpoint.                       |
| `LLM_MODEL`           | `gpt-4o-mini`            | Must exist in `LLM_COST_TABLE` for accurate savings.                     |
| `EMBED_MODEL`         | `text-embedding-3-small` | Must match `EMBED_DIM` (validated at startup).                           |
| `EMBED_DIM`           | `1536`                   | 1536 for 3-small/ada-002, 3072 for 3-large.                              |
| `RATE_LIMIT_PER_HOUR` | `20`                     | Per-IP, atomic Lua sliding window.                                       |
| `RATE_LIMIT_PER_DAY`  | `100`                    | Same.                                                                    |
| `DAILY_BUDGET_USD`    | `10`                     | Hard cap on LLM spend per day. Atomic reservation pre-call.              |
| `SEMANTIC_THRESHOLD`  | `0.08`                   | Cosine **distance** (0–2). Lower = stricter. ~0.08 ≈ similarity ≥ 0.92.  |
| `MODERATION_ENABLED`  | unset                    | Set to `true` for OpenAI moderation pre-check (~50ms).                   |
| `LOG_IP_SALT`         | random per-process       | Long random string for production. Daily-rotating HMAC salt for log IPs. |

## Deploying

The Next.js app is stateless and runs anywhere; the harder part is hosting
Valkey + valkey-search.

**Recommended: Vercel + EC2.**

- **Vercel** for the web app (set the env vars from `.env.example`).
- **EC2** for Valkey using the `valkey/valkey-bundle:8.1` image (which
  already loads the search/bloom/json/ldap modules).
- Connect over `rediss://` with a strong `requirepass` or - better - a
  scoped ACL user. See `.env.example` for a sample `valkey.conf` snippet.
- Vercel Pro doesn't ship dedicated egress IPs, so security groups can't be
  IP-locked. **TLS + ACL is the security boundary.** Don't expose plaintext
  Valkey to the internet.
- Run `pnpm build:index` from EC2 (or your laptop), **never** from a Vercel
  function - embedding 3k+ docs would blow past the 60s function timeout.

### Limitations

- **Cost numbers are estimates.** OpenAI prices change; update
  `lib/pricing.ts` and re-deploy. Semantic-cache hits report the cost stored
  at the time of the original `store()` call, which may be stale if pricing
  has changed since.
- **No multi-tenant isolation.** All users share one rate-limit and budget
  bucket per IP. Don't run this as-is for a customer-facing product without
  adding per-account scoping.
- **Crawled docs go stale.** Re-run `pnpm ingest && pnpm build:index`
  periodically (or wire it into a cron / CI job).
- **Semantic-cache distance threshold is global.** If two unrelated questions
  share vector neighbourhood (rare but happens), they'll cross-pollinate
  cache results. Tune `SEMANTIC_THRESHOLD` if this becomes a problem.

### Privacy

Three places persist user input. Pick which ones you're comfortable with:

| Sink                                                   | What it stores                                        | Default                                     | Disable                                                          |
| ------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| **Valkey log stream** (`playground:logs`)              | Hashed IP + secret-scrubbed prompt + per-turn metrics | always on                                   | comment out the `logTurn(...)` call in `app/api/chat/route.ts`   |
| **Semantic cache entry** (`playground_scache:entry:*`) | Raw prompt + raw response + embedding                 | always on                                   | required by the cache; trim retention via `SEMANTIC_TTL_SECONDS` |
| **PostHog `chat_turn` event**                          | Raw prompt + raw IP + every per-turn metric           | off until `BETTERDB_POSTHOG_API_KEY` is set | unset the key, or set `BETTERDB_TELEMETRY=false`                 |

Detail:

- `lib/secrets.ts` redacts obvious credential shapes (OpenAI keys, JWTs,
  AWS keys, GitHub PATs, Slack / Stripe tokens) before anything is written
  to the **log stream** or the **semantic cache**. PostHog gets the raw
  prompt - that's the whole reason it's there.
- Log-stream IPs are HMAC-SHA256'd with a daily-rotating salt. Set
  `LOG_IP_SALT` to a long random string in production so cross-day
  correlation requires that secret.
- The semantic cache stores the raw prompt in valkey-search to enable
  similarity matching. Anyone with read access to the Valkey instance can
  read past prompts - treat it like an application database.
- PostHog's retention is controlled in PostHog. If you turn it on, configure
  retention there to match your privacy commitments.

## Scripts

| Script                   | What it does                                                |
| ------------------------ | ----------------------------------------------------------- |
| `pnpm dev`               | Next.js dev server on `:3000`                               |
| `pnpm build`             | Production build                                            |
| `pnpm typecheck`         | `tsc --noEmit` with strict + `noUncheckedIndexedAccess`     |
| `pnpm lint`              | `next lint`                                                 |
| `pnpm format` / `:check` | Prettier write / verify                                     |
| `pnpm test`              | Vitest unit tests                                           |
| `pnpm ingest:valkey`     | Crawl `valkey.io/commands` + `/topics` → JSONL              |
| `pnpm ingest:redis`      | Crawl `redis.io/docs/latest/commands` → JSONL               |
| `pnpm ingest`            | Both above, sequentially (polite pacing)                    |
| `pnpm build:index`       | Embed JSONL docs + upsert into `valkey-search` (`docs_idx`) |
| `pnpm seed`              | Pre-warm semantic cache from `data/faq.jsonl`               |
| `pnpm tail:logs`         | Pretty-print last 100 entries from the request log stream   |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Code of Conduct in
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). Security disclosures go to
[SECURITY.md](./SECURITY.md).

## License

MIT - see [LICENSE](./LICENSE). The crawled documentation under `data/` is
not part of this license; it remains under its original Valkey / Redis OSS
licensing.
