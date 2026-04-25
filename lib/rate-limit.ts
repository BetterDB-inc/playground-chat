import { valkey } from "./valkey";

interface RateLimitResult {
  ok: boolean;
  retryAfter?: number;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Sliding-window rate limiter using Valkey sorted sets.
 * Tracks hourly and daily request counts per IP.
 */
export async function rateLimit(ip: string): Promise<RateLimitResult> {
  const now = nowSec();
  const hourKey = `playground:rl:hour:${ip}`;
  const dayKey = `playground:rl:day:${ip}`;

  const hourLimit = Number(process.env.RATE_LIMIT_PER_HOUR ?? 20);
  const dayLimit = Number(process.env.RATE_LIMIT_PER_DAY ?? 100);

  // Use pipeline for atomic batch
  const p = valkey.pipeline();

  // Evict old entries
  p.zremrangebyscore(hourKey, 0, now - 3600);
  p.zremrangebyscore(dayKey, 0, now - 86400);

  // Count current window
  p.zcard(hourKey);
  p.zcard(dayKey);

  const results = (await p.exec()) as [Error | null, unknown][];
  const hourCount = (results[2][1] as number) ?? 0;
  const dayCount = (results[3][1] as number) ?? 0;

  if (hourCount >= hourLimit) {
    return { ok: false, retryAfter: 3600 };
  }
  if (dayCount >= dayLimit) {
    return { ok: false, retryAfter: 86400 };
  }

  // Record this request
  const member = `${now}:${Math.random().toString(36).slice(2)}`;
  const p2 = valkey.pipeline();
  p2.zadd(hourKey, now, member);
  p2.expire(hourKey, 3600);
  p2.zadd(dayKey, now, member);
  p2.expire(dayKey, 86400);
  await p2.exec();

  return { ok: true };
}

/**
 * Daily budget kill-switch. Returns false if spend exceeds DAILY_BUDGET_USD.
 */
export async function checkBudget(costUsd: number): Promise<boolean> {
  const budget = Number(process.env.DAILY_BUDGET_USD ?? 10);
  const date = new Date().toISOString().slice(0, 10);
  const key = `playground:budget:${date}`;

  // costUsd stored as microdollars
  const micros = Math.round(costUsd * 1_000_000);
  const total = await valkey.incrby(key, micros);
  await valkey.expire(key, 86400 * 2);

  return total / 1_000_000 <= budget;
}

export async function getBudgetSpent(): Promise<number> {
  const date = new Date().toISOString().slice(0, 10);
  const key = `playground:budget:${date}`;
  const val = await valkey.get(key);
  return val ? Number(val) / 1_000_000 : 0;
}

export async function isBudgetExceeded(): Promise<boolean> {
  const budget = Number(process.env.DAILY_BUDGET_USD ?? 10);
  const spent = await getBudgetSpent();
  return spent >= budget;
}
