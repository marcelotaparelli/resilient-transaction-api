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

export class ProviderInvalidResponseError extends Error {
  constructor() {
    super("Payment provider returned an invalid response");
    this.name = "ProviderInvalidResponseError";
  }
}

export class ProviderRejectedError extends Error {
  constructor() {
    super("Payment provider rejected the transaction");
    this.name = "ProviderRejectedError";
  }
}
