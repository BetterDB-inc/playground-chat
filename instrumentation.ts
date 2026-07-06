/**
 * Next.js instrumentation hook — runs once per server process before any
 * request handling.
 *
 * When LANGWATCH_API_KEY is set, registers a global OpenTelemetry tracer
 * provider that exports spans to LangWatch (self-hosted or cloud) over
 * OTLP/HTTP. This lights up three layers at once:
 *
 *   1. App-level spans (chat.turn, tool.*, retrieval.query, memory.recall —
 *      see lib/telemetry.ts and their call sites).
 *   2. AI SDK spans from `experimental_telemetry` on streamText (LLM
 *      generations, tool calls, token usage).
 *   3. @betterdb package-internal spans (semantic_cache.*, agent_cache.*,
 *      agent_memory.*) — the packages call trace.getTracer() on the global
 *      API, so they need zero extra wiring once a provider exists.
 *
 * Without the key this registers nothing: @opentelemetry/api falls back to
 * no-op tracers and the app behaves exactly as before.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.LANGWATCH_API_KEY) return;

  // Dynamic imports keep the OTel SDK out of the bundle when disabled.
  const { registerOTel } = await import("@vercel/otel");
  const { LangWatchExporter } = await import("langwatch/observability");

  registerOTel({
    serviceName: "betterdb-playground-chat",
    // Reads LANGWATCH_API_KEY + LANGWATCH_ENDPOINT from the environment.
    traceExporter: new LangWatchExporter({
      // Applied sequentially (AND semantics). Beyond the default HTTP-noise
      // preset, drop Next.js framework spans (resolve page components,
      // executing api route, start response) so `chat.turn` is the trace
      // root — and health-check/page-load traces, which are *only* framework
      // spans, disappear entirely. Also drop PostHog analytics fetches;
      // OpenAI fetch spans stay (they show real latency in the waterfall).
      filters: [
        { preset: "excludeHttpRequests" },
        { exclude: { instrumentationScopeName: [{ equals: "next.js" }] } },
        { exclude: { name: [{ startsWith: "fetch POST https://eu.i.posthog.com" }] } },
      ],
    }),
  });
}
