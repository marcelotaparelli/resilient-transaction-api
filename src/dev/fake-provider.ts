import { z } from "zod";
import type { ProviderResult } from "../application/ports/payment-provider";

const providerRequestSchema = z
  .object({
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().length(3),
    description: z.string().min(1).max(200),
  })
  .strict();

export type FakeProviderOutcome =
  | "success"
  | "timeout"
  | "network_error"
  | "invalid_json"
  | "invalid_schema"
  | 400
  | 401
  | 403
  | 404
  | 409
  | 429
  | 500
  | 502
  | 503
  | 504;

const supportedStatuses = new Set([
  400, 401, 403, 404, 409, 429, 500, 502, 503, 504,
]);
const namedOutcomes = new Set([
  "success",
  "timeout",
  "network_error",
  "invalid_json",
  "invalid_schema",
]);

export function parseFakeProviderOutcomes(
  raw: string | undefined,
): FakeProviderOutcome[] {
  if (raw === undefined || raw.trim() === "") {
    return ["success"];
  }

  return raw.split(",").map((part) => {
    const value = part.trim().toLowerCase();
    if (namedOutcomes.has(value)) {
      return value as FakeProviderOutcome;
    }

    const status = Number(value);
    if (Number.isInteger(status) && supportedStatuses.has(status)) {
      return status as FakeProviderOutcome;
    }

    throw new Error(`Unsupported fake provider outcome: ${part}`);
  });
}

export type FakeProviderOptions = {
  outcomes: FakeProviderOutcome[];
  latencyMs?: number;
  timeoutDelayMs?: number;
  onNetworkError?: () => void;
};

function validateDelay(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

export function createFakeProviderHandler(
  options: FakeProviderOptions,
): (request: Request) => Promise<Response> {
  if (options.outcomes.length === 0) {
    throw new Error("Fake provider requires at least one outcome");
  }

  const latencyMs = options.latencyMs ?? 0;
  const timeoutDelayMs = options.timeoutDelayMs ?? 60_000;
  validateDelay("latencyMs", latencyMs);
  validateDelay("timeoutDelayMs", timeoutDelayMs);

  const transactions = new Map<string, ProviderResult>();
  let outcomeIndex = 0;
  let transactionSequence = 0;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/transactions") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    const idempotencyKey = request.headers.get("Idempotency-Key");
    if (idempotencyKey === null || idempotencyKey.trim() === "") {
      return Response.json(
        { error: "missing_idempotency_key" },
        { status: 400 },
      );
    }

    if (latencyMs > 0) {
      await Bun.sleep(latencyMs);
    }

    const previous = transactions.get(idempotencyKey);
    if (previous !== undefined) {
      return Response.json(previous, { status: 200 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    const parsed = providerRequestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "invalid_transaction", issues: parsed.error.issues },
        { status: 422 },
      );
    }

    const outcome = options.outcomes[outcomeIndex] ?? "success";
    outcomeIndex += 1;

    if (typeof outcome === "number") {
      return Response.json({ error: `configured_${outcome}` }, { status: outcome });
    }

    transactionSequence += 1;
    const result: ProviderResult = {
      providerTransactionId: `fake-provider-${String(transactionSequence).padStart(6, "0")}`,
      decision: "approved",
    };

    if (outcome === "success") {
      transactions.set(idempotencyKey, result);
      return Response.json(result, { status: 201 });
    }

    if (outcome === "timeout") {
      transactions.set(idempotencyKey, result);
      await Bun.sleep(timeoutDelayMs);
      return Response.json(result, { status: 201 });
    }

    if (outcome === "network_error") {
      transactions.set(idempotencyKey, result);
      options.onNetworkError?.();
      throw new Error("Configured fake provider network failure");
    }

    transactions.set(idempotencyKey, result);
    if (outcome === "invalid_json") {
      return new Response("not-json", {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    return Response.json({ decision: "approved" }, { status: 201 });
  };
}
