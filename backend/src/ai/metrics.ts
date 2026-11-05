type Outcome = "success" | "error";
type Provider = "OpenRouter" | "Anthropic" | "OpenAI";
type CounterKey = `${string}|${Provider}|${Outcome}`;

const latencyBuckets = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30];
const requestCounts = new Map<CounterKey, number>();
const latencyCounts = new Map<string, number>();
const latencySums = new Map<string, number>();

function safeLabel(value: string): string {
  return /^[a-z][a-z0-9_.-]{0,48}$/.test(value) ? value : "other";
}

export function recordAiRequest(input: {
  operation: string;
  provider: Provider;
  outcome: Outcome;
  latencyMs: number;
}): void {
  const operation = safeLabel(input.operation);
  const key = `${operation}|${input.provider}|${input.outcome}` as CounterKey;
  requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);

  const seconds = Math.max(0, input.latencyMs / 1000);
  const histogramKey = `${operation}|${input.provider}`;
  latencyCounts.set(histogramKey, (latencyCounts.get(histogramKey) ?? 0) + 1);
  latencySums.set(histogramKey, (latencySums.get(histogramKey) ?? 0) + seconds);
  for (const bucket of latencyBuckets) {
    if (seconds <= bucket) {
      const keyForBucket = `${histogramKey}|${bucket}`;
      latencyCounts.set(keyForBucket, (latencyCounts.get(keyForBucket) ?? 0) + 1);
    }
  }
}

export function renderAiPrometheusMetrics(): string {
  const lines = [
    "# HELP fitos_ai_requests_total AI provider requests by operation, provider, and outcome.",
    "# TYPE fitos_ai_requests_total counter",
    ...[...requestCounts.entries()].map(([key, value]) => {
      const [operation, provider, outcome] = key.split("|");
      return `fitos_ai_requests_total{operation="${operation}",provider="${provider}",outcome="${outcome}"} ${value}`;
    }),
    "# HELP fitos_ai_request_duration_seconds AI provider request latency.",
    "# TYPE fitos_ai_request_duration_seconds histogram",
  ];

  for (const [histogramKey, sum] of latencySums.entries()) {
    const count = latencyCounts.get(histogramKey) ?? 0;
    const [operation, provider] = histogramKey.split("|");
    for (const bucket of latencyBuckets) {
      const bucketCount = latencyCounts.get(`${histogramKey}|${bucket}`) ?? 0;
      lines.push(`fitos_ai_request_duration_seconds_bucket{operation="${operation}",provider="${provider}",le="${bucket}"} ${bucketCount}`);
    }
    lines.push(`fitos_ai_request_duration_seconds_bucket{operation="${operation}",provider="${provider}",le="+Inf"} ${count}`);
    lines.push(`fitos_ai_request_duration_seconds_sum{operation="${operation}",provider="${provider}"} ${latencySums.get(histogramKey) ?? 0}`);
    lines.push(`fitos_ai_request_duration_seconds_count{operation="${operation}",provider="${provider}"} ${count}`);
  }

  return lines.join("\n") + "\n";
}
