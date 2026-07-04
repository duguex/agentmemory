import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("iii-sdk", () => ({
  TriggerAction: {
    Void: () => ({ type: "void" }),
    Enqueue: (opts: { queue: string }) => ({ type: "enqueue", ...opts }),
  },
}));

import { registerApiTriggers } from "../src/triggers/api.js";

describe("api::compress endpoint", () => {
  let sdk: any;
  let kv: any;
  let handler: any;
  let triggerCalls: any[];
  let triggerConfig: { api_path: string; http_method: string } | null;

  beforeEach(() => {
    handler = undefined;
    triggerCalls = [];
    triggerConfig = null;
    sdk = {
      registerFunction: vi.fn((id: string, h: any) => {
        if (id === "api::compress") handler = h;
      }),
      registerTrigger: vi.fn((cfg: any) => {
        if (cfg?.function_id === "api::compress") {
          triggerConfig = cfg.config;
        }
      }),
      trigger: vi.fn(async (input: any) => {
        triggerCalls.push(input);
        return { ok: true, queued: true };
      }),
    };
    kv = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    };
    // Bypass auth for these tests (no secret).
    registerApiTriggers(sdk, kv);
  });

  it("registers a POST trigger at /agentmemory/compress", () => {
    expect(triggerConfig?.api_path).toBe("/agentmemory/compress");
    expect(triggerConfig?.http_method).toBe("POST");
    expect(typeof handler).toBe("function");
  });

  it("rejects missing sessionId with 400", async () => {
    const result = await handler({
      body: { observationId: "obs-1" },
      headers: {},
    });
    expect(result.status_code).toBe(400);
    expect(JSON.stringify(result.body)).toContain("sessionId");
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("rejects missing observationId with 400", async () => {
    const result = await handler({
      body: { sessionId: "sess-1" },
      headers: {},
    });
    expect(result.status_code).toBe(400);
    expect(JSON.stringify(result.body)).toContain("observationId");
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("rejects when both are missing with 400", async () => {
    const result = await handler({ body: {}, headers: {} });
    expect(result.status_code).toBe(400);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("rejects empty-string sessionId with 400", async () => {
    const result = await handler({
      body: { sessionId: "   ", observationId: "obs-1" },
      headers: {},
    });
    expect(result.status_code).toBe(400);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("enqueues mem::compress with { sessionId, observationId } payload", async () => {
    const result = await handler({
      body: { sessionId: "sess-1", observationId: "obs-1" },
      headers: {},
    });
    expect(result.status_code).toBe(200);
    expect(triggerCalls).toHaveLength(1);
    const call = triggerCalls[0];
    expect(call.function_id).toBe("mem::compress");
    expect(call.payload).toEqual({ sessionId: "sess-1", observationId: "obs-1" });
    // Critical: payload must NOT include `raw` (mem::compress now reads by ID).
    expect(call.payload).not.toHaveProperty("raw");
    // Critical: action must be Enqueue({queue:"mem::compress"}) for persistence.
    expect(call.action).toEqual({ type: "enqueue", queue: "mem::compress" });
  });

  it("returns 200 with the trigger result body", async () => {
    sdk.trigger.mockResolvedValueOnce({ enqueued: true });
    const result = await handler({
      body: { sessionId: "sess-2", observationId: "obs-2" },
      headers: {},
    });
    expect(result.status_code).toBe(200);
    expect(result.body).toEqual({ enqueued: true });
  });

  it("whitelists payload: does NOT forward extra fields", async () => {
    await handler({
      body: {
        sessionId: "sess-1",
        observationId: "obs-1",
        function_id: "evil",
        raw: "huge payload",
        extra: "should-not-appear",
      },
      headers: {},
    });
    const call = triggerCalls[0];
    expect(call.payload).toEqual({ sessionId: "sess-1", observationId: "obs-1" });
  });
});
