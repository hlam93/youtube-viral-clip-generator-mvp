interface CacheEntry<TValue> {
  expiresAt: number;
  value: TValue;
}

export class AsyncValueCache<TValue> {
  private readonly values = new Map<string, CacheEntry<TValue>>();
  private readonly inflight = new Map<string, Promise<TValue | null>>();

  constructor(private readonly ttlMs: number) {}

  async getOrLoad(key: string, loader: () => Promise<TValue | null>) {
    const cached = this.values.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    if (cached) {
      this.values.delete(key);
    }

    const inflight = this.inflight.get(key);
    if (inflight) {
      return inflight;
    }

    const next = loader()
      .then((value) => {
        if (value !== null) {
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
}
