import { describe, expect, test } from "bun:test";
import {
  hashApiKey,
  Sha256ServiceAuthenticator,
} from "../../src/http/security/service-authenticator";

const firstKey = "first-high-entropy-service-key-000001";
const secondKey = "second-high-entropy-service-key-00002";

describe("Sha256ServiceAuthenticator", () => {
  test("resolves only the service associated with a valid API key hash", async () => {
    const authenticator = new Sha256ServiceAuthenticator([
      { serviceId: "service-a", apiKeySha256: hashApiKey(firstKey) },
      { serviceId: "service-b", apiKeySha256: hashApiKey(secondKey) },
    ]);

    expect(await authenticator.authenticate(firstKey)).toEqual({
      id: "service-a",
    });
    expect(await authenticator.authenticate(secondKey)).toEqual({
      id: "service-b",
    });
    expect(
      await authenticator.authenticate("invalid-high-entropy-key-000000"),
    ).toBeNull();
  });

  test("stores fixed-length digests suitable for timingSafeEqual", () => {
    expect(hashApiKey(firstKey)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashApiKey(firstKey)).toBe(hashApiKey(firstKey));
    expect(hashApiKey(firstKey)).not.toBe(hashApiKey(secondKey));
  });

  test("rejects malformed or duplicate credential configuration", () => {
    expect(
      () =>
        new Sha256ServiceAuthenticator([
          { serviceId: "invalid service", apiKeySha256: "a".repeat(64) },
        ]),
    ).toThrow("configuration is invalid");
    expect(
      () =>
        new Sha256ServiceAuthenticator([
          { serviceId: "service-a", apiKeySha256: "a".repeat(64) },
          { serviceId: "service-a", apiKeySha256: "b".repeat(64) },
        ]),
    ).toThrow("configuration is invalid");
  });
});
