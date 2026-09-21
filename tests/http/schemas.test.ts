import { describe, expect, test } from "bun:test";
import {
  clientIdSchema,
  idempotencyKeySchema,
} from "../../src/http/schemas/header-schema";
import { paginationSchema } from "../../src/http/schemas/pagination-schema";
import { transactionSchema } from "../../src/http/schemas/transaction-schema";

describe("HTTP schemas", () => {
  test("accepts integer minor units and normalizes currency", () => {
    const result = transactionSchema.parse({
      amount: 1099,
      currency: "brl",
      description: "  Order 123  ",
    });

    expect(result).toEqual({
      amount: 1099,
      currency: "BRL",
      description: "Order 123",
    });
  });

  test("rejects non-positive and fractional amounts", () => {
    const result = transactionSchema.safeParse({
      amount: 10.99,
      currency: "BRL",
      description: "Order 123",
    });

    expect(result.success).toBeFalse();
  });

  test("rejects unexpected transaction fields", () => {
    const result = transactionSchema.safeParse({
      amount: 1099,
      currency: "BRL",
      description: "Order 123",
      accountId: "legacy-account",
    });

    expect(result.success).toBeFalse();
  });

  test("rejects descriptions above 200 characters", () => {
    const result = transactionSchema.safeParse({
      amount: 1099,
      currency: "BRL",
      description: "x".repeat(201),
    });

    expect(result.success).toBeFalse();
  });

  test("limits client and idempotency identifiers to 128 characters", () => {
    expect(clientIdSchema.safeParse("x".repeat(129)).success).toBeFalse();
    expect(idempotencyKeySchema.safeParse("x".repeat(129)).success).toBeFalse();
  });

  test("rejects a page limit above 100", () => {
    const result = paginationSchema.safeParse({ page: "1", limit: "101" });

    expect(result.success).toBeFalse();
  });
});
