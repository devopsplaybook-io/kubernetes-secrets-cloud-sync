import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  OTelEndSpan,
  OTelSetTracer,
  OTelStartSpan,
  OTelTracer,
  toError,
} from "./OTelContext";

interface FakeSpan {
  setAttribute: jest.Mock;
  recordException: jest.Mock;
  setStatus: jest.Mock;
  end: jest.Mock;
}

function fakeSpan(): FakeSpan {
  return {
    setAttribute: jest.fn(),
    recordException: jest.fn(),
    setStatus: jest.fn(),
    end: jest.fn(),
  };
}

describe("OTelContext span helpers", () => {
  let span: FakeSpan;
  let tracer: { startSpan: jest.Mock; shutdown: jest.Mock };

  beforeEach(() => {
    span = fakeSpan();
    tracer = {
      startSpan: jest.fn(() => span),
      shutdown: jest.fn(async () => undefined),
    };
  });

  afterEach(() => {
    OTelSetTracer(undefined as never);
  });

  it("returns undefined and does nothing before telemetry is initialized", () => {
    OTelSetTracer(undefined as never);
    expect(OTelTracer()).toBeUndefined();
    expect(OTelStartSpan("x")).toBeUndefined();
    expect(() => OTelEndSpan(undefined)).not.toThrow();
  });

  it("starts internal spans without the synthetic HTTP attributes", () => {
    OTelSetTracer(tracer as never);
    const parent = fakeSpan();
    const result = OTelStartSpan(
      "sync-run",
      { "sync.namespaces": 2, skipped: undefined },
      parent as never,
    );

    expect(result).toBe(span);
    expect(tracer.startSpan).toHaveBeenCalledWith("sync-run", parent, {
      kind: SpanKind.INTERNAL,
    });
    expect(span.setAttribute).toHaveBeenCalledTimes(1);
    expect(span.setAttribute).toHaveBeenCalledWith("sync.namespaces", 2);
  });

  it("starts parentless spans with options too", () => {
    OTelSetTracer(tracer as never);
    OTelStartSpan("source-fetch");

    expect(tracer.startSpan).toHaveBeenCalledWith("source-fetch", undefined, {
      kind: SpanKind.INTERNAL,
    });
  });

  it("ends a successful span without an error status", () => {
    OTelEndSpan(span as never);
    expect(span.end).toHaveBeenCalledTimes(1);
    expect(span.recordException).not.toHaveBeenCalled();
    expect(span.setStatus).not.toHaveBeenCalled();
  });

  it("records the exception and error status for a handled failure", () => {
    const error = new Error("boom");
    OTelEndSpan(span as never, error);

    expect(span.recordException).toHaveBeenCalledWith(error);
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "boom",
    });
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("wraps non-Error values before recording them", () => {
    OTelEndSpan(span as never, "nope");
    expect(span.recordException).toHaveBeenCalledWith(expect.any(Error));
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "nope",
    });
  });
});

describe("toError", () => {
  it("returns Error instances unchanged", () => {
    const error = new Error("boom");
    expect(toError(error)).toBe(error);
  });

  it("wraps non-Error values", () => {
    expect(toError("boom").message).toBe("boom");
    expect(toError(undefined).message).toBe("undefined");
    expect(toError({ code: 1 }).message).toBe("[object Object]");
  });
});
