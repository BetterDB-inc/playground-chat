import { trace, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";

/**
 * App-level OpenTelemetry helpers. A tracer provider is only registered when
 * LANGWATCH_API_KEY is set (see instrumentation.ts); otherwise the global API
 * hands back no-op tracers, so every helper here is safe to call
 * unconditionally at ~zero cost.
 */

/** True when spans are actually exported (provider registered at startup). */
export const telemetryEnabled = Boolean(process.env.LANGWATCH_API_KEY);

/**
 * Include prompt/response/memory/document content on spans. Off by default:
 * without it spans carry metadata only (hit/miss, similarity, latency, cost),
 * which is safe to ship to a shared LangWatch project. Enable on demo/dev
 * deployments where seeing the full payloads in the trace view is the point.
 */
export const captureContent = process.env.LANGWATCH_CAPTURE_CONTENT === "true";

export const tracer = trace.getTracer("betterdb-playground-chat");

/**
 * Serialize a plain string into the SpanInputOutput JSON shape LangWatch
 * expects on `langwatch.input` / `langwatch.output` attributes.
 */
export function spanText(value: string): string {
  return JSON.stringify({ type: "text", value });
}

/**
 * Run `fn` inside an active span. Records exceptions, sets status, and always
 * ends the span. Child spans created within `fn` (including @betterdb package
 * spans and AI SDK telemetry spans) nest under it via context propagation.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}
