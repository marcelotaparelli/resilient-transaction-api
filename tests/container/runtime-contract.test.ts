import { describe, expect, test } from "bun:test";

const root = new URL("../../", import.meta.url);

async function text(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("container runtime contract", () => {
  test("pins Bun and installs frozen production dependencies in a non-root runtime", async () => {
    const dockerfile = await text("Dockerfile");

    expect(dockerfile).toContain("ARG BUN_VERSION=1.4.2");
    expect(dockerfile).toContain("oven/bun:${BUN_VERSION}-slim");
    expect(dockerfile).toContain("bun install --frozen-lockfile --production");
    expect(dockerfile).toContain("USER bun");
    expect(dockerfile).toContain("ENTRYPOINT []");
    expect(dockerfile).toContain('CMD ["bun", "src/main.ts"]');
    expect(dockerfile).toContain("/health/ready");
    expect(dockerfile).toContain("FROM runtime AS provider");
    expect(dockerfile).toContain("HEALTHCHECK NONE");
    expect(dockerfile).not.toContain("curl");
    expect(dockerfile).not.toContain("wget");
  });

  test("keeps migrations explicit and optional Redis out of API startup ordering", async () => {
    const compose = await text("compose.yml");
    const apiSection = compose.slice(compose.indexOf("  api:"));

    expect(compose).toContain("postgres:15.19-bookworm");
    expect(compose).toContain("redis:7.2.16-bookworm");
    expect(compose).toContain('command: ["bun", "src/infrastructure/database/migrate.ts"]');
    expect(compose).toContain("condition: service_completed_successfully");
    expect(apiSection).not.toContain("condition: service_healthy\n      redis:");
    expect(compose).toContain('"${API_PORT:-4002}:4002"');
    expect(compose).toContain("SERVICE_API_KEY_SHA256");
  });

  test("excludes local state and secrets from the build context", async () => {
    const dockerignore = await text(".dockerignore");

    for (const entry of [
      ".git",
      ".agent",
      ".agents",
      ".env",
      "node_modules",
      "coverage",
      "test-results",
      "*.log",
    ]) {
      expect(dockerignore.split("\n")).toContain(entry);
    }
  });

  test("keeps the final runtime stateless and free of secret/config copies", async () => {
    const dockerfile = await text("Dockerfile");
    expect(dockerfile).toContain("COPY --from=production-dependencies");
    expect(dockerfile).toContain("COPY --chown=bun:bun migrations ./migrations");
    expect(dockerfile).not.toContain("COPY .env");
    expect(dockerfile).not.toContain("COPY .git");
    expect(dockerfile).not.toContain("SERVICE_CREDENTIALS");
    expect(dockerfile).not.toContain("DATABASE_URL");
  });
});
