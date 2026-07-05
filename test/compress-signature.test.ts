import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerCompressFunction } from "../src/functions/compress.js";

describe("mem::compress signature change", () => {
  let sdk: any;
  let kv: any;
  let handler: any;

  beforeEach(() => {
    sdk = {
      registerFunction: vi.fn((id: string, h: any) => {
        if (id === "mem::compress") handler = h;
      }),
      trigger: vi.fn().mockResolvedValue(undefined),
    };
    // Mock returns a synthetic-shaped observation (not yet LLM-compressed).
    // Fields match the real RawObservation interface so buildCompressionPrompt
    // can run with realistic inputs.
    kv = {
      get: vi.fn().mockResolvedValue({
        id: "obs-1",
        sessionId: "sess-1",
        timestamp: "2026-07-04T00:00:00Z",
        hookType: "PostToolUse",
        toolName: "Read",
        toolInput: { file_path: "/tmp/foo" },
        toolOutput: "file contents",
        raw: {},
        compressionKind: "synthetic",
        compressionVersion: 1,
      }),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const mockProvider = {
      compress: vi.fn().mockResolvedValue(
        "<type>file_read</type><title>X</title>" +
          "<subtitle>s</subtitle><facts><fact>a</fact></facts>" +
          "<narrative>n</narrative><concepts><concept>c</concept></concepts>" +
          "<files><file>f</file></files><importance>5</importance>",
      ),
      describeImage: vi.fn(),
    };
    registerCompressFunction(sdk, kv, mockProvider as any);
  });

  it("accepts {observationId, sessionId} without raw field", async () => {
    process.env.AGENTMEMORY_AUTO_COMPRESS = "true";
    // No `raw` in payload — caller must read from KV by ID at drain time.
    await handler({ observationId: "obs-1", sessionId: "sess-1" });
    // Confirm kv.get was called (the function reads raw from KV).
    expect(kv.get).toHaveBeenCalled();
  });

  it("writes back with explicit compressionKind 'llm'", async () => {
    process.env.AGENTMEMORY_AUTO_COMPRESS = "true";
    await handler({ observationId: "obs-1", sessionId: "sess-1" });
    // The function must write the compressed observation back with
    // an explicit compressionKind field of "llm".
    expect(kv.set).toHaveBeenCalled();
    const lastSet = kv.set.mock.calls[kv.set.mock.calls.length - 1];
    const written = lastSet[2] as { compressionKind?: string };
    expect(written.compressionKind).toBe("llm");
  });

  it("calls kv.delete before kv.set to bypass schema lock", async () => {
    process.env.AGENTMEMORY_AUTO_COMPRESS = "true";
    // Track the order of all kv operations to prove delete precedes set.
    const callOrder: string[] = [];
    kv.delete.mockImplementation(() => {
      callOrder.push("delete");
      return Promise.resolve();
    });
    kv.set.mockImplementation(() => {
      callOrder.push("set");
      return Promise.resolve();
    });

    await handler({ observationId: "obs-1", sessionId: "sess-1" });

    // Both must have been called.
    expect(kv.delete).toHaveBeenCalled();
    expect(kv.set).toHaveBeenCalled();

    // kv.delete must be invoked with the same (scope, key) as kv.set,
    // so the subsequent set looks like a first-write under iii-engine
    // v0.11.2's per-key schema lock.
    const deleteArgs = kv.delete.mock.calls[0];
    const setArgs = kv.set.mock.calls[kv.set.mock.calls.length - 1];
    expect(deleteArgs[0]).toBe(setArgs[0]); // scope
    expect(deleteArgs[1]).toBe(setArgs[1]); // observationId

    // Order: delete must happen strictly before the final set.
    const deleteIdx = callOrder.indexOf("delete");
    const setIdx = callOrder.indexOf("set");
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeLessThan(setIdx);

    // The writeback payload must include compressionKind: "llm" so
    // the LLM upgrade is actually visible to downstream consumers.
    const written = setArgs[2] as { compressionKind?: string };
    expect(written.compressionKind).toBe("llm");
  });
});
