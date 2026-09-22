import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  requestId: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  operation: () => T,
): T {
  return storage.run(context, operation);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
