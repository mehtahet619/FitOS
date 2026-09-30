import { Redis } from "@upstash/redis";
import { createHash } from "node:crypto";

export interface BucketRequest { key: string; capacity: number; refillPerSecond: number; }
export interface BucketResult { allowed: boolean; retryAfter: number; }
export interface AtomicBucketStore {
  consumeMany(requests: BucketRequest[], nowMs: number): Promise<BucketResult>;
}

/** Local/test implementation. Production always uses RedisBucketStore. */
export class MemoryBucketStore implements AtomicBucketStore {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private tail: Promise<void> = Promise.resolve();
  async consumeMany(requests: BucketRequest[], nowMs: number): Promise<BucketResult> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const states = requests.map((r) => {
        const old = this.buckets.get(r.key) ?? { tokens: r.capacity, updatedAt: nowMs };
        const tokens = Math.min(r.capacity, old.tokens + Math.max(0, nowMs - old.updatedAt) / 1000 * r.refillPerSecond);
        return { ...r, tokens };
      });
      const denied = states.find((s) => s.tokens < 1);
      if (denied) return { allowed: false, retryAfter: Math.max(1, Math.ceil((1 - denied.tokens) / denied.refillPerSecond)) };
      states.forEach((s) => this.buckets.set(s.key, { tokens: s.tokens - 1, updatedAt: nowMs }));
      return { allowed: true, retryAfter: 0 };
    } finally { release(); }
  }
}

const LUA_CONSUME = `
local now = tonumber(ARGV[1]); local count = tonumber(ARGV[2]);
local states = {}; local denied = 0;
for i=1,count do
  local cap = tonumber(ARGV[2 + (i-1)*2 + 1]);
  local rate = tonumber(ARGV[2 + (i-1)*2 + 2]);
  local values = redis.call('HMGET', KEYS[i], 'tokens', 'updatedAt');
  local tokens = tonumber(values[1]) or cap; local updated = tonumber(values[2]) or now;
  tokens = math.min(cap, tokens + math.max(0, now-updated)/1000*rate);
  states[i] = {tokens, rate}; if tokens < 1 then denied = math.max(denied, math.ceil((1-tokens)/rate)); end;
end
if denied > 0 then return {0, denied}; end
for i=1,count do
  redis.call('HSET', KEYS[i], 'tokens', states[i][1]-1, 'updatedAt', now);
  redis.call('EXPIRE', KEYS[i], 7200);
end
return {1, 0};
`;

export class RedisBucketStore implements AtomicBucketStore {
  private readonly redis: Redis;
  constructor(url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN) {
    if (!url || !token) throw new Error("Shared OTP rate-limit storage is not configured");
    this.redis = new Redis({ url, token });
  }
  async consumeMany(requests: BucketRequest[], nowMs: number): Promise<BucketResult> {
    const args = [String(nowMs), String(requests.length), ...requests.flatMap((r) => [String(r.capacity), String(r.refillPerSecond)])];
    const result = await (this.redis.eval as unknown as (script: string, keys: string[], args: string[]) => Promise<number[]>)(LUA_CONSUME, requests.map((r) => r.key), args);
    return { allowed: Number(result[0]) === 1, retryAfter: Number(result[1]) };
  }
}

export class TokenBucketRateLimiter {
  constructor(private readonly store: AtomicBucketStore, private readonly now = () => Date.now()) {}
  consumeRegistration(email: string, ip: string): Promise<BucketResult> {
    const normalized = email.trim().toLowerCase();
    const ipKey = createHash("sha256").update(ip).digest("hex");
    const namespace = normalized.startsWith("password:") ? "password" : "register";
    return this.store.consumeMany([
      { key: `otp:bucket:${namespace}:email:${normalized.replace(/^password:/, "")}`, capacity: 50, refillPerSecond: 50 / 60 },
      { key: `otp:bucket:${namespace}:ip:${ipKey}`, capacity: 20, refillPerSecond: 20 / 60 },
    ], this.now());
  }
}

let limiter: TokenBucketRateLimiter | undefined;
export function getOtpLimiter(): TokenBucketRateLimiter {
  if (!limiter) limiter = new TokenBucketRateLimiter(process.env.NODE_ENV === "test" ? new MemoryBucketStore() : new RedisBucketStore());
  return limiter;
}
