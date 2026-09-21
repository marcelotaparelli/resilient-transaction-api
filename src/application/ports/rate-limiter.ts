export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export interface RateLimiter {
  consume(subjectId: string): Promise<RateLimitResult>;
}
