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
  return active.length <= limit;
};

export const checkSearchRateLimit = (ip: string, token: string) => {
  const ipAllowed = recordAndCheck(ipBucket, ip, APP_CONFIG.rateLimits.searchPerMinutePerIp);
  const tokenAllowed = recordAndCheck(tokenBucket, token, APP_CONFIG.rateLimits.searchPerMinutePerToken);
  return ipAllowed && tokenAllowed;
};
