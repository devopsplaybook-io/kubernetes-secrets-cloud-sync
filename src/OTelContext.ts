import {
  StandardLogger,
  StandardTracer,
} from "@devopsplaybook.io/otel-utils";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { Span } from "@opentelemetry/sdk-trace-base";

let tracer: StandardTracer | undefined;
let logger: StandardLogger;

export function OTelSetTracer(tracerIn: StandardTracer) {
  tracer = tracerIn;
}

export function OTelTracer(): StandardTracer | undefined {
  return tracer;
}

export function OTelLogger(): StandardLogger {
  if (!logger) {
    logger = new StandardLogger();
  }
  return logger;
}

/** Normalize an unknown thrown value into an Error for structured logging. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Start an internal span. Returns undefined when telemetry has not been
 * initialized, so callers can stay instrumentation-free in tests.
 */
export function OTelStartSpan(
  name: string,
  attributes?: Record<string, unknown>,
  parent?: Span,
): Span | undefined {
  if (!tracer) {
    return undefined;
  }
  const span = tracer.startSpan(name, parent, { kind: SpanKind.INTERNAL });
  if (attributes) {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) {
        span.setAttribute(key, value as never);
      }
    }
  }
  return span;
}

/**
 * End a span. A handled error is recorded as an exception and marks the span
 * as failed; `undefined` spans are ignored.
 */
export function OTelEndSpan(span: Span | undefined, error?: unknown): void {
  if (!span) {
    return;
  }
  if (error !== undefined) {
    const normalized = toError(error);
    span.recordException(normalized);
    span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message });
  }
  span.end();
}
