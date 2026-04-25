# Security policy

> **Forking this repo?** The contact below is a placeholder using the
> reserved `.invalid` TLD so it can never be a real address. Replace it
> with one you actually monitor _before_ publishing your fork - otherwise
> security reports will fall on the floor. (`grep -R REPLACE-ME` to find
> all spots.)

## Reporting a vulnerability

Please email **REPLACE-ME-BEFORE-PUBLISHING@example.invalid** with a
description of the issue, reproduction steps, and the impact you've assessed.
We aim to respond within 3 business days.

Do **not** open a public GitHub issue for security reports. Once a fix is
prepared and shipped, we'll publish a brief advisory crediting the reporter
(unless you'd prefer to remain anonymous).

## Scope

This repository is an example/demo. Reports we care about:

- Authentication or authorisation bypass in the chat or stats routes
- Server-side request forgery (SSRF) via tools or the embedding path
- Prompt injection that bypasses the daily budget gate or rate limiter
- Secret exfiltration via cached responses or log streams
- Credentials or tokens accidentally committed to the repository

Out of scope (won't be treated as vulnerabilities):

- Rate limit bypass that doesn't affect cost or availability
- Default-config issues that the README warns about (e.g. running with a
  weak `requirepass`)
- Issues only reproducible against unmaintained dependencies after we've
  upgraded

## Hardening guidance for operators

If you deploy this playground publicly, please:

- Set `OPENAI_API_KEY` from a secret store (Vercel env vars, AWS Secrets
  Manager, Fly secrets) - never commit it.
- Enable TLS on Valkey when reachable from the internet (`rediss://` URL).
- Set `LOG_IP_SALT` to a long random string so log IPs aren't correlatable
  across deploys.
- Set `MODERATION_ENABLED=true` if you expect untrusted users.
- Tune `RATE_LIMIT_PER_HOUR`, `RATE_LIMIT_PER_DAY`, and `DAILY_BUDGET_USD`
  conservatively for your audience.
