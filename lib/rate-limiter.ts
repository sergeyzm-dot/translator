interface RateLimiterOptions {
  interval: number;
  uniqueTokenPerInterval: number;
}

interface TokenBucket {
  count: number;
  lastRefill: number;
}

export class RateLimiter {
  private interval: number;
  private maxRequests: number;
  private tokens: Map<string, TokenBucket> = new Map();

  constructor(options: RateLimiterOptions) {
    this.interval = options.interval;
    this.maxRequests = options.uniqueTokenPerInterval;
  }

  async check(limit: number, token: string): Promise<void> {
    const now = Date.now();
    const bucket = this.tokens.get(token) || { count: 0, lastRefill: now };

    // Refill tokens based on time passed
    const timePassed = now - bucket.lastRefill;
    const tokensToAdd = Math.floor(timePassed / this.interval) * limit;
    
    if (tokensToAdd > 0) {
      bucket.count = Math.min(limit, bucket.count + tokensToAdd);
      bucket.lastRefill = now;
    }

    if (bucket.count < 1) {
      throw new Error('Rate limit exceeded');
    }

    bucket.count -= 1;
    this.tokens.set(token, bucket);

    // Clean up old entries periodically
    if (Math.random() < 0.01) {
      this.cleanup(now);
    }
  }

  private cleanup(now: number): void {
    for (const [token, bucket] of this.tokens.entries()) {
      if (now - bucket.lastRefill > this.interval * 2) {
        this.tokens.delete(token);
      }
    }
  }
}