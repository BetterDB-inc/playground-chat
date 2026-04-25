import { valkey } from "./valkey";

/**
 * Per-IP sliding-window rate limiter and per-day spend kill-switch.
 *
 * Both checks are implemented in single-shot Lua so the read-modify-write
 * happens atomically server-side. Without this, two concurrent requests at
 * the boundary can both pass the check before either records its mutation.
 */

interface RateLimitResult {
  ok: boolean;
  retryAfter?: number;
  /** Remaining requests in the tighter of the two windows. */
  remaining?: number;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Atomic sliding-window check + insert. Trims both the hour and day windows,
 * counts each, and only inserts the new entry if both limits would still be
 * respected after the insert. KEYS:[hourKey, dayKey] ARGV:[now, hourLimit,
 * dayLimit, member].
 *
 * Returns: { ok, hourCount, dayCount, retryAfter? }
 */
const SLIDING_WINDOW_SCRIPT = `
local hourKey = KEYS[1]
local dayKey  = KEYS[2]
local now      = tonumber(ARGV[1])
local hourMax  = tonumber(ARGV[2])
local dayMax   = tonumber(ARGV[3])
local member   = ARGV[4]

redis.call('ZREMRANGEBYSCORE', hourKey, 0, now - 3600)
redis.call('ZREMRANGEBYSCORE', dayKey,  0, now - 86400)

local hourCount = tonumber(redis.call('ZCARD', hourKey))
local dayCount  = tonumber(redis.call('ZCARD', dayKey))

if hourCount >= hourMax then
  return {0, hourCount, dayCount, 3600}
end
if dayCount >= dayMax then
  return {0, hourCount, dayCount, 86400}
end

redis.call('ZADD', hourKey, now, member)
redis.call('EXPIRE', hourKey, 3600)
redis.call('ZADD', dayKey, now, member)
redis.call('EXPIRE', dayKey, 86400)

return {1, hourCount + 1, dayCount + 1, 0}
`;

export async function rateLimit(ip: string): Promise<RateLimitResult> {
  const now = nowSec();
  const hourLimit = Number(process.env.RATE_LIMIT_PER_HOUR ?? 20);
  const dayLimit = Number(process.env.RATE_LIMIT_PER_DAY ?? 100);
  const hourKey = `playground:rl:hour:${ip}`;
  const dayKey = `playground:rl:day:${ip}`;
  const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;

  const raw = (await valkey.eval(
    SLIDING_WINDOW_SCRIPT,
    2,
    hourKey,
    dayKey,
    String(now),
    String(hourLimit),
    String(dayLimit),
    member,
  )) as [number, number, number, number];

  const [ok, hourCount, dayCount, retryAfter] = raw;
  if (ok === 0) return { ok: false, retryAfter };
  const remaining = Math.min(hourLimit - hourCount, dayLimit - dayCount);
  return { ok: true, remaining };
}

/**
 * Atomic budget gate. Reads the current daily total; if adding `pendingCost`
 * would exceed the budget, returns `ok:false` and does NOT increment.
 * Otherwise it increments and returns `ok:true`. Costs are stored in
 * microdollars so we can use INCRBY atomically without losing precision.
 *
 * KEYS:[dayKey] ARGV:[pendingMicros, budgetMicros, ttlSec]
 * Returns: { ok, totalMicros }
 */
const BUDGET_SCRIPT = `
local key            = KEYS[1]
local pendingMicros  = tonumber(ARGV[1])
local budgetMicros   = tonumber(ARGV[2])
local ttl            = tonumber(ARGV[3])

local current = tonumber(redis.call('GET', key) or 0)
if current + pendingMicros > budgetMicros then
  return {0, current}
end

local total = redis.call('INCRBY', key, pendingMicros)
if redis.call('TTL', key) < 0 then
  redis.call('EXPIRE', key, ttl)
end
return {1, total}
`;

interface BudgetResult {
  ok: boolean;
  spentUsd: number;
  budgetUsd: number;
}

function todayKey(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `playground:budget:${date}`;
}

/**
 * Atomically reserve `pendingCostUsd` against the daily budget. Returns
 * ok=false if the call would push us over.
 *
 * Use this as a *pre-call* gate with an estimated cost (input-token-based),
 * then call `recordActualCost` after the call to true up the difference.
 */
export async function reserveBudget(pendingCostUsd: number): Promise<BudgetResult> {
  const budget = Number(process.env.DAILY_BUDGET_USD ?? 10);
  const pendingMicros = Math.max(0, Math.round(pendingCostUsd * 1_000_000));
  const budgetMicros = Math.round(budget * 1_000_000);

  const raw = (await valkey.eval(
    BUDGET_SCRIPT,
    1,
    todayKey(),
    String(pendingMicros),
    String(budgetMicros),
    String(86400 * 2),
  )) as [number, number];
  const [ok, totalMicros] = raw;
  return {
    ok: ok === 1,
    spentUsd: totalMicros / 1_000_000,
    budgetUsd: budget,
  };
}

/**
 * Record the difference between the estimated and actual cost. Negative deltas
 * (we estimated too high) are clamped to zero - once we've reserved budget,
 * we don't give it back, to keep the limit conservative under load.
 */
export async function settleBudget(estimatedUsd: number, actualUsd: number): Promise<void> {
  const delta = Math.max(0, actualUsd - estimatedUsd);
  if (delta === 0) return;
  const micros = Math.round(delta * 1_000_000);
  await valkey.incrby(todayKey(), micros);
}

export async function getBudgetSpent(): Promise<number> {
  const val = await valkey.get(todayKey());
  return val ? Number(val) / 1_000_000 : 0;
}

export async function isBudgetExceeded(): Promise<boolean> {
  const budget = Number(process.env.DAILY_BUDGET_USD ?? 10);
  const spent = await getBudgetSpent();
  return spent >= budget;
}
