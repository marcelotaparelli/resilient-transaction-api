export class ProviderTimeoutError extends Error {
  constructor() {
    super("Payment provider request timed out");
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderUnavailableError extends Error {
  constructor() {
    super("Payment provider is unavailable");
    this.name = "ProviderUnavailableError";
  }
}

export class ProviderNetworkError extends Error {
  constructor() {
    super("Payment provider network request failed");
    this.name = "ProviderNetworkError";
  }
}

export class ProviderRateLimitedError extends Error {
  constructor() {
    super("Payment provider rate limit was exceeded");
    this.name = "ProviderRateLimitedError";
  }
}

export class ProviderServerError extends Error {
  constructor(readonly status: number) {
    super("Payment provider returned a server error");
    this.name = "ProviderServerError";
  }
}

export class ProviderCircuitOpenError extends Error {
  constructor() {
    super("Payment provider circuit is open");
    this.name = "ProviderCircuitOpenError";
  }
}

export class ProviderInvalidResponseError extends Error {
  constructor() {
    super("Payment provider returned an invalid response");
    this.name = "ProviderInvalidResponseError";
  }
}

export class ProviderRejectedError extends Error {
  constructor(readonly status?: number) {
    super("Payment provider rejected the transaction");
    this.name = "ProviderRejectedError";
  }
}
