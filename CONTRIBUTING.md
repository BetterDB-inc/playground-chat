# Contributing

Thanks for your interest in the BetterDB Playground! This is an example/demo
project meant to show how `@betterdb/agent-cache` and `@betterdb/semantic-cache`
work end-to-end on a real chat application. Contributions of all sizes are
welcome.

## Quick start (local)

```bash
# 1. Install
pnpm install

# 2. Bring up Valkey + valkey-search
docker compose up -d

# 3. Configure env
cp .env.example .env
# fill in OPENAI_API_KEY at minimum

# 4. Build the doc index (runs once; see scripts/README for details)
pnpm ingest:valkey
pnpm ingest:redis
pnpm build:index
pnpm seed             # optional - pre-warms the semantic cache from data/faq.jsonl

# 5. Run dev server
pnpm dev
# open http://localhost:3000
```

## Project layout

```
app/                Next.js App Router pages + API routes
components/         React UI components
hooks/              Reusable React hooks
lib/                Shared server modules (cache, RAG, pricing, env, etc.)
scripts/            Doc ingest + index building + cache seeding
data/               Curated FAQ (faq.jsonl). Crawled docs are gitignored.
```

## Before opening a PR

- `pnpm typecheck` passes
- `pnpm lint` passes
- `pnpm test` passes (if you added tests; please do for non-trivial logic)
- New env vars are documented in `.env.example` AND, if required at boot,
  added to `validateEnv()` in `lib/env.ts` so misconfiguration fails fast
  instead of producing an opaque 500 on the first request
- New tools added to `lib/tools.ts` follow the `cached(name, args, fn, { costEstimateUsd })` pattern so cache-savings reporting stays accurate.

## Code style

- TypeScript with `strict` + `noUncheckedIndexedAccess`. Don't `// @ts-ignore` -
  if a type is wrong, fix it at the source.
- Comments explain _why_, not _what_. The diff already shows what changed.
- Keep modules small and focused. New cross-cutting helpers go in `lib/`.

## Reporting issues

When filing a bug, include:

- Node and pnpm versions
- Whether Valkey is running via the bundled compose or your own setup
- The first error from `pnpm dev` or the request log entry from `pnpm tail:logs`
- For UI bugs: browser + viewport size

## Security

If you find a security issue, please don't open a public issue - see
[SECURITY.md](./SECURITY.md).
