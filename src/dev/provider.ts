import {
  createFakeProviderHandler,
  parseFakeProviderOutcomes,
} from "./fake-provider";

function readNonNegativeInteger(name: string, fallback: number): number {
  const value = Number(Bun.env[name] ?? String(fallback));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

const outcomes = parseFakeProviderOutcomes(Bun.env.PROVIDER_OUTCOMES);
const latencyMs = readNonNegativeInteger("PROVIDER_LATENCY_MS", 0);
const timeoutDelayMs = readNonNegativeInteger(
  "PROVIDER_TIMEOUT_DELAY_MS",
  60_000,
);

let server: ReturnType<typeof Bun.serve>;
const handler = createFakeProviderHandler({
  outcomes,
  latencyMs,
  timeoutDelayMs,
  onNetworkError: () => server.stop(true),
});

server = Bun.serve({ port: 4003, fetch: handler });
