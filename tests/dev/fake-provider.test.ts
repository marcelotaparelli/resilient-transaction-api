import { describe, expect, test } from "bun:test";
import {
  createFakeProviderHandler,
  parseFakeProviderOutcomes,
} from "../../src/dev/fake-provider";

function request(key: string): Request {
  return new Request("http://provider/transactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({
      amount: 1099,
      currency: "BRL",
      description: "Order 123",
    }),
  });
}

describe("deterministic fake provider", () => {
  test("parses a deterministic sequence of supported outcomes", () => {
    expect(parseFakeProviderOutcomes("503, 503, success")).toEqual([
      503,
      503,
      "success",
    ]);
    expect(() => parseFakeProviderOutcomes("random")).toThrow(
      "Unsupported fake provider outcome",
    );
  });

  test("consumes outcomes in order and preserves provider idempotency", async () => {
    const handler = createFakeProviderHandler({
      outcomes: [503, 503, "success"],
    });

    expect((await handler(request("same-key"))).status).toBe(503);
    expect((await handler(request("same-key"))).status).toBe(503);
    const created = await handler(request("same-key"));
    const replay = await handler(request("same-key"));

    expect(created.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await created.json());
  });

  test("invalid responses model an ambiguous side effect and replay the stored result", async () => {
    for (const outcome of ["invalid_json", "invalid_schema"] as const) {
      const handler = createFakeProviderHandler({ outcomes: [outcome] });
      const first = await handler(request(`${outcome}-key`));
      const replay = await handler(request(`${outcome}-key`));

      expect(first.status).toBe(201);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ decision: "approved" });
    }
  });

  test("network failure is deterministic and records the external result before disconnect", async () => {
    let disconnects = 0;
    const handler = createFakeProviderHandler({
      outcomes: ["network_error"],
      onNetworkError: () => {
        disconnects += 1;
      },
    });

    await expect(handler(request("network-key"))).rejects.toThrow(
      "Configured fake provider network failure",
    );
    const replay = await handler(request("network-key"));
    expect(disconnects).toBe(1);
    expect(replay.status).toBe(200);
  });
});
