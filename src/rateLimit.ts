import { APP_CONFIG } from './config.js';

const WINDOW_MS = 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000;

type LimitBucket = Map<string, number[]>;

const ipBucket: LimitBucket = new Map();
const tokenBucket: LimitBucket = new Map();
let lastCleanupAt = Date.now();

const prune = (entries: number[], now: number) => entries.filter((timestamp) => now - timestamp < WINDOW_MS);

// Every key that has ever made a request otherwise stays in the map forever: prune()
// only runs when that same key is seen again, so one-off anonymous tokens (no reuse
// expected) would accumulate without bound. Sweep and evict expired keys periodically,
// piggybacked on existing request-driven calls rather than a background timer.
const sweep = (bucket: LimitBucket, now: number) => {
  for (const [key, entries] of bucket) {
    const active = prune(entries, now);
    if (active.length === 0) {
      bucket.delete(key);
    } else {
      bucket.set(key, active);
    }
  }
};

const maybeCleanup = (now: number) => {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) {
    return;
  }

  lastCleanupAt = now;
  sweep(ipBucket, now);
  sweep(tokenBucket, now);
};

const recordAndCheck = (bucket: LimitBucket, key: string, limit: number) => {
  const now = Date.now();
  const active = prune(bucket.get(key) ?? [], now);
  active.push(now);
  bucket.set(key, active);
  return {
    allowed: active.length <= limit,
    count: active.length
  };
};

export interface SearchRateLimitResult {
  allowed: boolean;
  limitedBy: 'ip' | 'token' | 'ip_and_token' | null;
  ipCount: number;
  tokenCount: number;
}

export const checkSearchRateLimit = (ip: string, token: string) => {
  maybeCleanup(Date.now());
  const ipResult = recordAndCheck(ipBucket, ip, APP_CONFIG.rateLimits.searchPerMinutePerIp);
  const tokenResult = recordAndCheck(tokenBucket, token, APP_CONFIG.rateLimits.searchPerMinutePerToken);

  const limitedBy =
    ipResult.allowed && tokenResult.allowed
      ? null
      : !ipResult.allowed && !tokenResult.allowed
        ? 'ip_and_token'
        : !ipResult.allowed
          ? 'ip'
          : 'token';

  return {
    allowed: ipResult.allowed && tokenResult.allowed,
    limitedBy,
    ipCount: ipResult.count,
    tokenCount: tokenResult.count
  } satisfies SearchRateLimitResult;
};

export const resetSearchRateLimits = () => {
  ipBucket.clear();
  tokenBucket.clear();
  lastCleanupAt = Date.now();
};

// Test-support accessor for observing internal bucket sizes without exposing the raw Maps,
// mirroring the existing resetSearchRateLimits test-support export.
export const rateLimitDebugSnapshot = () => ({
  ipBucketSize: ipBucket.size,
  tokenBucketSize: tokenBucket.size
});
