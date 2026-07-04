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

describe("api::graph-build endpoint", () => {
  let sdk: any;
  let kv: any;
  let handler: any;
  let triggerCalls: any[];
  let triggerConfig: { api_path: string; http_method: string } | null;

  // Stub one session with a few compressed observations; each batch
  // triggers mem::graph-extract once.
  const sessions = [{ id: "sess-1" }];
  const observations = [
    {
      id: "obs-1",
      sessionId: "sess-1",
      timestamp: "2026-01-01T00:00:00Z",
      type: "discovery",
      title: "Finding 1",
      facts: [],
      narrative: "n1",
      concepts: [],
      files: [],
      importance: 1,
    },
    {
      id: "obs-2",
      sessionId: "sess-1",
      timestamp: "2026-01-01T00:00:01Z",
      type: "discovery",
      title: "Finding 2",
      facts: [],
      narrative: "n2",
      concepts: [],
      files: [],
      importance: 1,
    },
    // Raw (no title) — should be filtered out.
    {
      id: "obs-raw",
      sessionId: "sess-1",
      timestamp: "2026-01-01T00:00:02Z",
      type: "tool_use",
      title: "",
      facts: [],
      narrative: "raw",
      concepts: [],
      files: [],
      importance: 0,
    },
  ];

  beforeEach(() => {
    handler = undefined;
    triggerCalls = [];
    triggerConfig = null;
    sdk = {
      registerFunction: vi.fn((id: string, h: any) => {
        if (id === "api::graph-build") handler = h;
      }),
      registerTrigger: vi.fn((cfg: any) => {
        if (cfg?.function_id === "api::graph-build") {
          triggerConfig = cfg.config;
        }
      }),
      trigger: vi.fn(async (input: any) => {
        triggerCalls.push(input);
        return { success: true, nodesAdded: 1, edgesAdded: 0 };
      }),
    };
    // kv.list is overloaded based on the first arg (scope).
    // - KV.sessions ("mem:sessions") -> returns sessions array
    // - KV.observations(sid) ("mem:obs:<sid>") -> returns observations array for that sid
    kv = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(async (scope: any) => {
        const key = typeof scope === "string" ? scope : String(scope);
        if (key === "mem:sessions") return sessions;
        if (key === `mem:obs:sess-1`) return observations;
        return [];
      }),
    };
    registerApiTriggers(sdk, kv);
  });

  it("registers a POST trigger at /agentmemory/graph/build", () => {
    expect(triggerConfig?.api_path).toBe("/agentmemory/graph/build");
    expect(triggerConfig?.http_method).toBe("POST");
    expect(typeof handler).toBe("function");
  });

  it("triggers mem::graph-extract with { sessionId, observationIds } payload", async () => {
    const result = await handler({ body: {}, headers: {} });
    expect(result.status_code).toBe(200);
    expect(triggerCalls.length).toBeGreaterThanOrEqual(1);

    const extractCalls = triggerCalls.filter(
      (c: any) => c.function_id === "mem::graph-extract",
    );
    expect(extractCalls.length).toBeGreaterThanOrEqual(1);

    // The session may also trigger other mem::* functions; we only
    // care that graph-extract uses the new shape.
    const batch = extractCalls[0].payload;
    expect(batch).toHaveProperty("sessionId", "sess-1");
    expect(Array.isArray(batch.observationIds)).toBe(true);
    // All observationIds in the batch must be present in the source observations.
    for (const id of batch.observationIds) {
      expect(observations.find((o) => o.id === id)).toBeTruthy();
    }
    // Critical regression guards: Task 6 migrated mem::graph-extract to
    // { sessionId, observationIds }; the old { observations: [...] } shape
    // is silently rejected by the consumer. Ensure api::graph-build does
    // NOT send the legacy shape.
    expect(batch).not.toHaveProperty("observations");
  });

  it("filters out observations without a title", async () => {
    await handler({ body: {}, headers: {} });
    const extractCalls = triggerCalls.filter(
      (c: any) => c.function_id === "mem::graph-extract",
    );
    const allIds: string[] = extractCalls.flatMap(
      (c: any) => c.payload.observationIds,
    );
    // obs-raw has empty title; api::graph-build must filter it out.
    expect(allIds).not.toContain("obs-raw");
    expect(allIds).toContain("obs-1");
    expect(allIds).toContain("obs-2");
  });

  it("returns success and aggregate counts in the response body", async () => {
    const result = await handler({ body: {}, headers: {} });
    expect(result.status_code).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.sessions).toBe(1);
    expect(typeof result.body.batches).toBe("number");
    expect(typeof result.body.nodes).toBe("number");
    expect(typeof result.body.edges).toBe("number");
  });

  it("respects batchSize override (one batch per session)", async () => {
    // batchSize=1 forces two triggers: one for obs-1, one for obs-2.
    await handler({ body: { batchSize: 1 }, headers: {} });
    const extractCalls = triggerCalls.filter(
      (c: any) => c.function_id === "mem::graph-extract",
    );
    expect(extractCalls.length).toBe(2);
    expect(extractCalls[0].payload.observationIds).toEqual(["obs-1"]);
    expect(extractCalls[1].payload.observationIds).toEqual(["obs-2"]);
    for (const c of extractCalls) {
      expect(c.payload.sessionId).toBe("sess-1");
      expect(c.payload).not.toHaveProperty("observations");
    }
  });

  it("clamps batchSize into [1, 100]", async () => {
    // Over-large batchSize should be clamped to 100; with only 2 obs it
    // still produces one batch. We assert the call still works rather
    // than testing the clamp upper bound directly (which needs >100 obs).
    await handler({ body: { batchSize: 10000 }, headers: {} });
    const extractCalls = triggerCalls.filter(
      (c: any) => c.function_id === "mem::graph-extract",
    );
    expect(extractCalls.length).toBe(1);
  });
});
