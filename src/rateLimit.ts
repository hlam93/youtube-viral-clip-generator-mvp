import { APP_CONFIG } from './config.js';

const WINDOW_MS = 60_000;

type LimitBucket = Map<string, number[]>;

const ipBucket: LimitBucket = new Map();
const tokenBucket: LimitBucket = new Map();

const prune = (entries: number[], now: number) => entries.filter((timestamp) => now - timestamp < WINDOW_MS);

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
};
