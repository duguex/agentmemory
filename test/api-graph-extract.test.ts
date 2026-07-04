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

describe("api::graph-extract endpoint", () => {
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
        if (id === "api::graph-extract") handler = h;
      }),
      registerTrigger: vi.fn((cfg: any) => {
        if (cfg?.function_id === "api::graph-extract") {
          triggerConfig = cfg.config;
        }
      }),
      trigger: vi.fn(async (input: any) => {
        triggerCalls.push(input);
        return { success: true, nodesAdded: 0, edgesAdded: 0 };
      }),
    };
    kv = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    };
    registerApiTriggers(sdk, kv);
  });

  it("registers a POST trigger at /agentmemory/graph/extract", () => {
    expect(triggerConfig?.api_path).toBe("/agentmemory/graph/extract");
    expect(triggerConfig?.http_method).toBe("POST");
    expect(typeof handler).toBe("function");
  });

  it("rejects missing sessionId with 400", async () => {
    const result = await handler({
      body: { observationIds: ["obs-1"] },
      headers: {},
    });
    expect(result.status_code).toBe(400);
    expect(JSON.stringify(result.body)).toContain("sessionId");
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("rejects missing observationIds with 400", async () => {
    const result = await handler({
      body: { sessionId: "sess-1" },
      headers: {},
    });
    expect(result.status_code).toBe(400);
    expect(JSON.stringify(result.body)).toContain("observationIds");
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("rejects empty observationIds array with 400", async () => {
    const result = await handler({
      body: { sessionId: "sess-1", observationIds: [] },
      headers: {},
    });
    expect(result.status_code).toBe(400);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("rejects empty-string sessionId with 400", async () => {
    const result = await handler({
      body: { sessionId: "", observationIds: ["obs-1"] },
      headers: {},
    });
    expect(result.status_code).toBe(400);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("triggers mem::graph-extract with { sessionId, observationIds } shape", async () => {
    const result = await handler({
      body: { sessionId: "sess-1", observationIds: ["obs-1", "obs-2"] },
      headers: {},
    });
    expect(result.status_code).toBe(200);
    expect(triggerCalls).toHaveLength(1);
    const call = triggerCalls[0];
    expect(call.function_id).toBe("mem::graph-extract");
    expect(call.payload).toEqual({
      sessionId: "sess-1",
      observationIds: ["obs-1", "obs-2"],
    });
    // Critical regression guards: legacy {observations: [...]} shape
    // must NOT be sent to mem::graph-extract anymore (Task 6 payload change).
    expect(call.payload).not.toHaveProperty("observations");
  });

  it("whitelists payload: does NOT forward extra fields", async () => {
    await handler({
      body: {
        sessionId: "sess-1",
        observationIds: ["obs-1"],
        function_id: "evil",
        observations: [{ title: "sneaky" }],
        extra: "should-not-appear",
      },
      headers: {},
    });
    const call = triggerCalls[0];
    expect(call.payload).toEqual({
      sessionId: "sess-1",
      observationIds: ["obs-1"],
    });
    expect(call.payload).not.toHaveProperty("observations");
    expect(call.payload).not.toHaveProperty("extra");
  });

  it("returns 200 with the trigger result body", async () => {
    sdk.trigger.mockResolvedValueOnce({
      success: true,
      nodesAdded: 3,
      edgesAdded: 2,
    });
    const result = await handler({
      body: { sessionId: "sess-2", observationIds: ["obs-2"] },
      headers: {},
    });
    expect(result.status_code).toBe(200);
    expect(result.body).toEqual({
      success: true,
      nodesAdded: 3,
      edgesAdded: 2,
    });
  });
});
