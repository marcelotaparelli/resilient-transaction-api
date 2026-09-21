function validatePrefix(prefix: string): void {
  if (!/^[a-zA-Z0-9:_-]{1,64}$/.test(prefix)) {
    throw new Error("Redis key prefix is invalid");
  }
}

export function transactionCacheKey(prefix: string, transactionId: string): string {
  validatePrefix(prefix);
  return `${prefix}:${encodeURIComponent(transactionId)}`;
}

export function rateLimitKey(prefix: string, clientId: string): string {
  validatePrefix(prefix);
  return `${prefix}:${encodeURIComponent(clientId)}`;
}
