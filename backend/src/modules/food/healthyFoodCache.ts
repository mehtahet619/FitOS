import { Redis } from "@upstash/redis";
import { createHash, randomUUID } from "node:crypto";

const CACHE_TTL_SECONDS = 10 * 60;
const LOCK_TTL_SECONDS = 180;
const WAIT_FOR_SHARED_RESULT_MS = 20_000;
const POLL_INTERVAL_MS = 750;

type CacheEnvelope<T> = { cachedAt: number; value: T };
const inFlight = new Map<string, Promise<unknown>>();
const memoryCache = new Map<string, { expiresAt: number; value: unknown }>();

function redisClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  try { return new Redis({ url, token }); } catch { return null; }
}

const redis = redisClient();

function keyFor(namespace: string, key: string): string {
  return `fitos:healthy-food:${namespace}:${createHash("sha256").update(key).digest("hex")}`;
}

async function readCache<T>(key: string): Promise<T | undefined> {
  if (redis) {
    try {
      const value = await redis.get<CacheEnvelope<T>>(keyFor("cache", key));
      if (value && typeof value === "object" && "value" in value) return value.value;
    } catch (error) {
      console.warn("[healthy-food] Shared cache read failed; continuing without it.", error instanceof Error ? error.message : String(error));
    }
  }
  const entry = memoryCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.value as T;
  if (entry) memoryCache.delete(key);
  return undefined;
}

async function writeCache<T>(key: string, value: T): Promise<void> {
  memoryCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
  if (redis) {
    try {
      await redis.set(keyFor("cache", key), { cachedAt: Date.now(), value } satisfies CacheEnvelope<T>, { ex: CACHE_TTL_SECONDS });
    } catch (error) {
      console.warn("[healthy-food] Shared cache write failed; retaining process cache only.", error instanceof Error ? error.message : String(error));
    }
  }
}

export async function getCachedHealthyFood<T>(key: string): Promise<T | undefined> {
  return readCache<T>(key);
}

/**
 * Coalesces duplicate searches. Upstash provides cross-instance coordination in
 * production; the in-process promise map is a safe fallback for local development.
 */
export async function runHealthyFoodSearch<T>(key: string, work: () => Promise<T>, shouldCache: (value: T) => boolean = () => true): Promise<{ value: T; cached: boolean }> {
  const cached = await readCache<T>(key);
  if (cached !== undefined) return { value: cached, cached: true };

  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return { value: await existing, cached: true };

  const lockKey = keyFor("lock", key);
  const lockToken = randomUUID();
  let ownsLock = !redis;

  if (redis) {
    try {
      ownsLock = Boolean(await redis.set(lockKey, lockToken, { nx: true, ex: LOCK_TTL_SECONDS }));
    } catch (error) {
      console.warn("[healthy-food] Shared lock unavailable; using local coalescing.", error instanceof Error ? error.message : String(error));
      ownsLock = true;
    }
  }

  if (!ownsLock) {
    const deadline = Date.now() + WAIT_FOR_SHARED_RESULT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const shared = await readCache<T>(key);
      if (shared !== undefined) return { value: shared, cached: true };
    }
    throw new Error("A nearby-food search is already running for this area. Please retry in a few seconds.");
  }

  const task = (async () => {
    try {
      const value = await work();
      if (shouldCache(value)) await writeCache(key, value);
      return value;
    } finally {
      if (redis) {
        try {
          await redis.eval(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
            [lockKey],
            [lockToken],
          );
        } catch (error) {
          console.warn("[healthy-food] Shared lock release failed; it will expire automatically.", error instanceof Error ? error.message : String(error));
        }
      }
    }
  })();
  inFlight.set(key, task);
  try { return { value: await task, cached: false }; }
  finally { if (inFlight.get(key) === task) inFlight.delete(key); }
}
