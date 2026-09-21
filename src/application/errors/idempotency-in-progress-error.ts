export class IdempotencyInProgressError extends Error {
  constructor() {
    super("An operation with this idempotency key is already processing");
    this.name = "IdempotencyInProgressError";
  }
}
