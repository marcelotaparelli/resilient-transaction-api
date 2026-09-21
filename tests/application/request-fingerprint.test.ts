import { describe, expect, test } from "bun:test";
import { createRequestFingerprint } from "../../src/application/idempotency/request-fingerprint";

describe("createRequestFingerprint", () => {
  test("produces a deterministic SHA-256 from canonical business fields", async () => {
    const fingerprint = await createRequestFingerprint({
      amount: 1099,
      currency: "brl",
      description: "  Order 123  ",
    });

    expect(fingerprint).toBe(
      "a2e97cad2002b1babda12974e1821c08b3e416573a9bdcb33b74b6b4852ae10f",
    );
  });

  test("changes when a semantically relevant field changes", async () => {
    const first = await createRequestFingerprint({
      amount: 1099,
      currency: "BRL",
      description: "Order 123",
    });
    const second = await createRequestFingerprint({
      amount: 1100,
      currency: "BRL",
      description: "Order 123",
    });

    expect(first).not.toBe(second);
  });
});
