import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config so isGraphExtractionEnabled() returns true.
vi.mock("../src/config.js", () => ({
  isGraphExtractionEnabled: () => true,
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("iii-sdk", () => ({
  TriggerAction: {
    Void: () => ({ type: "void" }),
    Enqueue: (opts: { queue: string }) => ({ type: "enqueue", ...opts }),
  },
}));

import { registerGraphFunction } from "../src/functions/graph.js";
import type { CompressedObservation } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

const mockProvider = {
  name: "test",
  compress: vi.fn().mockResolvedValue(`<entities>
<entity type="file" name="src/index.ts"><property key="path">src/index.ts</property></entity>
<entity type="function" name="main"><property key="lang">typescript</property></entity>
</entities>
<relationships>
<relationship type="uses" source="src/index.ts" target="main" weight="0.9"/>
</relationships>`),
  summarize: vi.fn(),
};

function makeObs(id: string): CompressedObservation {
  return {
    id,
    sessionId: "ses_1",
    timestamp: "2026-02-01T10:00:00Z",
    type: "file_edit",
    title: `Edit ${id}`,
    facts: [`fact ${id}`],
    narrative: `Narrative for ${id}`,
    concepts: ["typescript"],
    files: ["src/index.ts"],
    importance: 7,
    compressionKind: "llm",
    confidence: 0.9,
  };
}

describe("events.ts graph-extract filter", () => {
  it("includes legacy observations (no compressionKind) with confidence>=0.7", () => {
    const observations = [
      { id: "obs-1", title: "t", confidence: 0.8 }, // legacy
      { id: "obs-2", title: "t", confidence: 0.3, compressionKind: "synthetic" as const }, // synthetic, exclude
      { id: "obs-3", title: "t", confidence: 0.9, compressionKind: "llm" as const }, // LLM, include
      { id: "obs-4", title: "t", confidence: 0.5 }, // legacy low confidence, exclude
    ];
    const filtered = observations.filter((o) =>
      o.compressionKind === "llm" ||
      (o.compressionKind === undefined &&
       typeof o.confidence === "number" &&
       o.confidence >= 0.7),
    );
    expect(filtered.map((o) => o.id)).toEqual(["obs-1", "obs-3"]);
  });
});

describe("mem::graph-extract consumer (new payload shape)", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    // Pre-seed two observations in KV.
    await kv.set("mem:obs:ses_1", "obs_1", makeObs("obs_1"));
    await kv.set("mem:obs:ses_1", "obs_2", makeObs("obs_2"));
    registerGraphFunction(sdk as never, kv as never, mockProvider as never);
  });

  it("reads observations from KV by ID when given { sessionId, observationIds }", async () => {
    const getSpy = vi.spyOn(kv, "get");

    const result = (await sdk.trigger("mem::graph-extract", {
      sessionId: "ses_1",
      observationIds: ["obs_1", "obs_2"],
    })) as { success: boolean; nodesAdded: number; edgesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(2);
    expect(result.edgesAdded).toBe(1);

    // Verify both observation IDs were read from the session-scoped KV.
    const obsScopeReads = getSpy.mock.calls.filter(
      ([scope]) => scope === "mem:obs:ses_1",
    );
    expect(obsScopeReads.length).toBe(2);
    expect(obsScopeReads.map(([, k]) => k).sort()).toEqual(["obs_1", "obs_2"]);

    // Provider was called exactly once (one batch extraction).
    expect(mockProvider.compress).toHaveBeenCalledTimes(1);

    // Two nodes (file + function) and one edge (uses) were created.
    const nodes = await kv.list<{ id: string; name: string; type: string }>(
      "mem:graph:nodes",
    );
    expect(nodes.length).toBe(2);
    const edges = await kv.list<{ id: string; type: string }>(
      "mem:graph:edges",
    );
    expect(edges.length).toBe(1);
    expect(edges[0].type).toBe("uses");
  });

  it("filters out IDs that don't exist in KV (defensive)", async () => {
    const result = (await sdk.trigger("mem::graph-extract", {
      sessionId: "ses_1",
      observationIds: ["obs_1", "missing-obs", "obs_2"],
    })) as { success: boolean; nodesAdded: number };

    // Only the two real observations drove the extraction — the missing
    // one was silently dropped.
    expect(result.success).toBe(true);
    expect(mockProvider.compress).toHaveBeenCalledTimes(1);

    // The prompt sent to the provider should only contain titles for
    // observations that actually exist (obs_1 and obs_2, not "missing-obs").
    const compressArgs = mockProvider.compress.mock.calls[0];
    const promptText = String(compressArgs[1] ?? "");
    expect(promptText).toContain("Edit obs_1");
    expect(promptText).toContain("Edit obs_2");
    expect(promptText).not.toContain("missing-obs");
  });

  it("returns failure when observationIds is empty", async () => {
    const result = (await sdk.trigger("mem::graph-extract", {
      sessionId: "ses_1",
      observationIds: [],
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no observations/i);
    expect(mockProvider.compress).not.toHaveBeenCalled();
  });
});