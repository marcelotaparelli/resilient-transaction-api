type Scenario =
  | "cache-hit"
  | "cache-miss"
  | "postgres-fallback"
  | "post-success"
  | "idempotent-replay";

type Sample = {
  latencyMs: number;
  status: number;
};

type BenchmarkResult = {
  scenario: Scenario;
  run: number;
  requests: number;
  concurrency: number;
  durationMs: number;
  completed: number;
  successful: number;
  errors: number;
  requestsPerSecond: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  statuses: Record<string, number>;
};

const args = new Map(
  Bun.argv.slice(2).map((argument) => {
    const [key, value = ""] = argument.replace(/^--/, "").split("=");
    return [key, value];
  }),
);

const scenario = args.get("scenario") as Scenario | undefined;
const run = Number(args.get("run") ?? "1");
const requests = Number(args.get("requests") ?? "300");
const concurrency = Number(args.get("concurrency") ?? "25");
const baseUrl = Bun.env.BENCHMARK_BASE_URL ?? "http://127.0.0.1:4002";
const apiKey = Bun.env.BENCHMARK_API_KEY;

if (
  scenario === undefined ||
  ![
    "cache-hit",
    "cache-miss",
    "postgres-fallback",
    "post-success",
    "idempotent-replay",
  ].includes(scenario) ||
  apiKey === undefined ||
  !Number.isSafeInteger(run) ||
  !Number.isSafeInteger(requests) ||
  requests <= 0 ||
  !Number.isSafeInteger(concurrency) ||
  concurrency <= 0
) {
  console.error(
    "Usage: bun benchmarks/http-benchmark.ts --scenario=<scenario> --run=1 --requests=300 --concurrency=25",
  );
  process.exit(2);
}

const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};

async function post(idempotencyKey: string): Promise<{ status: number; id?: string }> {
  const response = await fetch(`${baseUrl}/transactions`, {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({
      amount: 1099,
      currency: "BRL",
      description: `benchmark-${idempotencyKey}`,
    }),
  });
  const body = (await response.json()) as { id?: string };
  return { status: response.status, id: body.id };
}

async function get(id: string): Promise<number> {
  const response = await fetch(`${baseUrl}/transactions/${id}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  await response.arrayBuffer();
  return response.status;
}

async function seedOne(label: string): Promise<string> {
  const result = await post(`benchmark-${label}-${crypto.randomUUID()}`);
  if (result.status !== 201 || result.id === undefined) {
    throw new Error(`seed failed with status ${result.status}`);
  }
  return result.id;
}

async function seedMany(count: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(10, count) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= count) return;
      ids[index] = await seedOne(`${scenario}-${run}-${index}`);
    }
  });
  await Promise.all(workers);
  return ids;
}

async function warmup(operation: () => Promise<unknown>): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await operation();
  }
}

async function runLoad(operation: (index: number) => Promise<number>): Promise<BenchmarkResult> {
  const samples: Sample[] = [];
  let cursor = 0;
  const started = performance.now();
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= requests) return;
      const requestStarted = performance.now();
      try {
        const status = await operation(index);
        samples.push({
          latencyMs: performance.now() - requestStarted,
          status,
        });
      } catch {
        samples.push({
          latencyMs: performance.now() - requestStarted,
          status: 599,
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, requests) }, () => worker()),
  );
  const durationMs = performance.now() - started;
  const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const percentile = (ratio: number): number => {
    const position = Math.max(0, Math.ceil(ratio * latencies.length) - 1);
    return Number((latencies[position] ?? 0).toFixed(3));
  };
  const statuses = Object.fromEntries(
    [...new Set(samples.map((sample) => sample.status))]
      .sort((a, b) => a - b)
      .map((status) => [String(status), samples.filter((sample) => sample.status === status).length]),
  );
  const successful = samples.filter((sample) => sample.status >= 200 && sample.status < 300).length;
  return {
    scenario,
    run,
    requests,
    concurrency,
    durationMs: Number(durationMs.toFixed(3)),
    completed: samples.length,
    successful,
    errors: samples.length - successful,
    requestsPerSecond: Number((samples.length / (durationMs / 1000)).toFixed(3)),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    statuses,
  };
}

let operation: (index: number) => Promise<number>;

if (scenario === "cache-hit" || scenario === "postgres-fallback") {
  const id = await seedOne(`${scenario}-${run}-seed`);
  await warmup(() => get(id));
  operation = () => get(id);
} else if (scenario === "cache-miss") {
  const ids = await seedMany(requests);
  operation = (index) => get(ids[index] as string);
} else if (scenario === "post-success") {
  operation = async () => (await post(`benchmark-post-${run}-${crypto.randomUUID()}`)).status;
} else {
  const key = `benchmark-replay-${run}-${crypto.randomUUID()}`;
  const created = await post(key);
  if (created.status !== 201) throw new Error(`replay seed failed with status ${created.status}`);
  operation = async () => (await post(key)).status;
}

console.log(JSON.stringify(await runLoad(operation)));
