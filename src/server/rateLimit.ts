type Bucket = { count: number; resetAt: number };

export type LimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Fixed-window limiter. Auth state is in Postgres; these buckets are per process
 * and only shape traffic. /mcp is keyed by token hash so shared client IPs do
 * not share a bucket.
 */
export class RateLimiter {
    private readonly windows = new Map<string, Bucket>();

    constructor(
        private readonly maxRequests: number,
        private readonly windowMs: number,
    ) {}

    check(key: string): LimitDecision {
        const now = Date.now();
        const entry = this.windows.get(key);
        if (!entry || now >= entry.resetAt) {
            this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
            return { allowed: true };
        }
        if (entry.count >= this.maxRequests) {
            return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
        }
        entry.count += 1;
        return { allowed: true };
    }

    cleanup(): void {
        const now = Date.now();
        for (const [key, entry] of this.windows) {
            if (now >= entry.resetAt) this.windows.delete(key);
        }
    }
}
