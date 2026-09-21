export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export interface RateLimiter {
  consume(clientId: string): Promise<RateLimitResult>;
}
