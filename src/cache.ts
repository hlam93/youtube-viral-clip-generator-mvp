interface CacheEntry<TValue> {
  expiresAt: number;
  value: TValue;
}

export interface AsyncValueCacheStats {
  hits: number;
  misses: number;
  coalesced: number;
  stores: number;
}

export class AsyncValueCache<TValue> {
  private readonly values = new Map<string, CacheEntry<TValue>>();
  private readonly inflight = new Map<string, Promise<TValue | null>>();
  private readonly stats: AsyncValueCacheStats = {
    hits: 0,
    misses: 0,
    coalesced: 0,
    stores: 0
  };

  constructor(private readonly ttlMs: number) {}

  async getOrLoad(key: string, loader: () => Promise<TValue | null>) {
    const cached = this.values.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.stats.hits += 1;
      return cached.value;
    }

    if (cached) {
      this.values.delete(key);
    }

    const inflight = this.inflight.get(key);
    if (inflight) {
      this.stats.coalesced += 1;
      return inflight;
    }

    this.stats.misses += 1;
    const next = loader()
      .then((value) => {
        if (value !== null) {
          this.stats.stores += 1;
          this.values.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        }
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, next);
    return next;
  }

  clear() {
    this.values.clear();
    this.inflight.clear();
  }

  snapshotStats() {
    return { ...this.stats };
  }
}
