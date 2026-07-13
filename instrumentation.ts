/**
 * Next.js instrumentation hook — runs once per server process before any
 * request handling (Next calls the exported `register()` automatically).
 *
 * When MONITOR_OTLP_ENDPOINT is set, this registers a global OpenTelemetry
 * tracer provider that exports spans over OTLP/HTTP using the **JSON protocol**
 * to a BetterDB Monitor instance at `${MONITOR_OTLP_ENDPOINT}/v1/traces`.
 *
 * Why this is all it takes: the @betterdb/* packages (semantic-cache,
 * agent-cache, agent-memory, retrieval) each acquire their tracer from the
 * global @opentelemetry/api (`trace.getTracer(...)`) and emit spans
 * unconditionally. With no provider registered, @opentelemetry/api hands out
 * no-op tracers and nothing is exported. Registering one provider here wires
 * every library's cache-hit / cache-miss / recall / retrieval span straight
 * into Monitor's trace view — no per-call-site changes required.
 *
 * Without MONITOR_OTLP_ENDPOINT this registers nothing and the app behaves
 * exactly as before.
 */
export async function register(): Promise<void> {
  // OTel SDK is Node-only; skip the edge runtime.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const endpoint = process.env.MONITOR_OTLP_ENDPOINT?.replace(/\/+$/, "");
  if (!endpoint) return;

  // Dynamic import keeps the OTel SDK out of the bundle when tracing is off.
  const { registerOTel, OTLPHttpJsonTraceExporter } = await import("@vercel/otel");

  // Optional bearer auth — Monitor's OTLP ingest may require a token. Reuse
  // the same MCP token the optimize agent uses, or a dedicated one, if set.
  const token = process.env.MONITOR_OTLP_TOKEN ?? process.env.BETTERDB_TOKEN;
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "betterdb-playground-chat",
    traceExporter: new OTLPHttpJsonTraceExporter({
      // `http/json` OTLP endpoint on the Monitor.
      url: `${endpoint}/v1/traces`,
      headers,
    }),
  });
}
