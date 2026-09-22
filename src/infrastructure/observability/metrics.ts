const histogramBuckets = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
] as const;

type Labels = Readonly<Record<string, string>>;
export type ProviderFailureCategory =
  | "invalid_response"
  | "network"
  | "rate_limited"
  | "rejected"
  | "server"
  | "timeout"
  | "unknown";

const allowedHttpMethods = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);
const allowedHttpRoutes = new Set([
  "/health",
  "/health/live",
  "/health/ready",
  "/metrics",
  "/transactions",
  "/transactions/:id",
  "unmatched",
]);

type Histogram = {
  labels: Labels;
  count: number;
  sum: number;
  buckets: number[];
};

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labelKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("\u0000");
}

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) return "";
  return `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}`;
}

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

export class ApplicationMetrics {
  private readonly counters = new Map<
    string,
    { name: string; labels: Labels; value: number }
  >();
  private readonly httpDurations = new Map<string, Histogram>();

  recordHttp(method: string, route: string, status: number, seconds: number): void {
    const safeMethod = allowedHttpMethods.has(method) ? method : "OTHER";
    const safeRoute = allowedHttpRoutes.has(route) ? route : "unmatched";
    const safeStatus =
      Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : 500;
    const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
    const statusLabel = String(safeStatus);
    this.increment("http_requests_total", {
      method: safeMethod,
      route: safeRoute,
      status: statusLabel,
    });
    if (safeStatus >= 400) {
      this.increment("http_errors_total", {
        route: safeRoute,
        class: statusClass(safeStatus),
      });
    }

    const labels = {
      method: safeMethod,
      route: safeRoute,
      status_class: statusClass(safeStatus),
    };
    const key = labelKey(labels);
    let histogram = this.httpDurations.get(key);
    if (histogram === undefined) {
      histogram = {
        labels,
        count: 0,
        sum: 0,
        buckets: histogramBuckets.map(() => 0),
      };
      this.httpDurations.set(key, histogram);
    }
    histogram.count += 1;
    histogram.sum += safeSeconds;
    for (let index = 0; index < histogramBuckets.length; index += 1) {
      const boundary = histogramBuckets[index];
      if (boundary !== undefined && safeSeconds <= boundary) {
        histogram.buckets[index] = (histogram.buckets[index] ?? 0) + 1;
      }
    }
  }

  providerAttempt(): void {
    this.increment("provider_requests_total");
  }

  providerFailure(category: ProviderFailureCategory): void {
    this.increment("provider_failures_total", { category });
  }

  providerTimeout(): void {
    this.increment("provider_timeouts_total");
  }

  providerRetry(): void {
    this.increment("provider_retries_total");
  }

  circuitOpened(): void {
    this.increment("circuit_open_total");
  }

  cacheHit(): void {
    this.increment("cache_hit_total");
  }

  cacheMiss(): void {
    this.increment("cache_miss_total");
  }

  cacheError(operation: "get" | "set"): void {
    this.increment("cache_error_total", { operation });
  }

  rateLimitRejected(): void {
    this.increment("rate_limit_rejected_total");
  }

  redisError(operation: "cache_get" | "cache_set" | "rate_limit" | "readiness"): void {
    this.increment("redis_errors_total", { operation });
  }

  databaseError(operation: "readiness"): void {
    this.increment("database_errors_total", { operation });
  }

  value(name: string, labels: Labels = {}): number {
    return this.counters.get(`${name}\u0001${labelKey(labels)}`)?.value ?? 0;
  }

  render(): string {
    const lines = [
      "# HELP http_requests_total Total HTTP responses.",
      "# TYPE http_requests_total counter",
      "# HELP http_errors_total Total HTTP error responses by status class.",
      "# TYPE http_errors_total counter",
      "# HELP http_request_duration_seconds HTTP response latency in seconds.",
      "# TYPE http_request_duration_seconds histogram",
    ];

    const additionalCounterNames = [...new Set(
      [...this.counters.values()]
        .map((counter) => counter.name)
        .filter(
          (name) =>
            name !== "http_requests_total" && name !== "http_errors_total",
        ),
    )].sort();
    for (const name of additionalCounterNames) {
      lines.push(`# TYPE ${name} counter`);
    }

    for (const counter of [...this.counters.values()].sort((left, right) =>
      `${left.name}${labelKey(left.labels)}`.localeCompare(
        `${right.name}${labelKey(right.labels)}`,
      ),
    )) {
      lines.push(`${counter.name}${renderLabels(counter.labels)} ${counter.value}`);
    }

    for (const histogram of [...this.httpDurations.values()].sort((left, right) =>
      labelKey(left.labels).localeCompare(labelKey(right.labels)),
    )) {
      for (let index = 0; index < histogramBuckets.length; index += 1) {
        const boundary = histogramBuckets[index];
        lines.push(
          `http_request_duration_seconds_bucket${renderLabels({ ...histogram.labels, le: String(boundary) })} ${histogram.buckets[index] ?? 0}`,
        );
      }
      lines.push(
        `http_request_duration_seconds_bucket${renderLabels({ ...histogram.labels, le: "+Inf" })} ${histogram.count}`,
      );
      lines.push(
        `http_request_duration_seconds_sum${renderLabels(histogram.labels)} ${histogram.sum}`,
      );
      lines.push(
        `http_request_duration_seconds_count${renderLabels(histogram.labels)} ${histogram.count}`,
      );
    }

    return `${lines.join("\n")}\n`;
  }

  private increment(name: string, labels: Labels = {}): void {
    const key = `${name}\u0001${labelKey(labels)}`;
    const current = this.counters.get(key);
    if (current === undefined) {
      this.counters.set(key, { name, labels, value: 1 });
    } else {
      current.value += 1;
    }
  }
}
