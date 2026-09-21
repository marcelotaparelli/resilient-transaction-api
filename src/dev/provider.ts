import { z } from "zod";
import type { ProviderResult } from "../application/ports/payment-provider";

const providerRequestSchema = z.object({
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().length(3),
  description: z.string().min(1).max(200),
}).strict();

const transactions = new Map<string, ProviderResult>();
const delay = Number(Bun.env.PROVIDER_DELAY_MS ?? "0");

Bun.serve({
  port: 4003,
  async fetch(request): Promise<Response> {
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

    if (delay > 0) {
      await Bun.sleep(delay);
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

    const result: ProviderResult = {
      providerTransactionId: crypto.randomUUID(),
      decision: "approved",
    };

    transactions.set(idempotencyKey, result);
    return Response.json(result, { status: 201 });
  },
});
