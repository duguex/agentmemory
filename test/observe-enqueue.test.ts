import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  const triggered: Array<{
    id: string;
    data: unknown;
    raw: unknown;
  }> = [];
  return {
    fns,
    triggered,
    registerFunction: (
      idOrOpts: string | { id: string },
      fn: Function,
      _options?: Record<string, unknown>,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, fn);
    },
    trigger: async (
      input: string | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id = typeof input === "string" ? input : input.function_id;
      const payload = typeof input === "string" ? data : input.payload;
      const action = typeof input === "string" ? undefined : input.action;
      triggered.push({ id, data: payload, raw: input });
      const fn = fns.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

function validPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: "ses_test",
    hookType: "post_tool_use",
    timestamp: new Date().toISOString(),
    data: {
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
      tool_output: "file contents here",
    },
    ...overrides,
  };
}

describe("observe.ts: Enqueue outside AUTO_COMPRESS gate", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
  });
  afterEach(() => {
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
  });

  it("enqueues mem::compress even when AUTO_COMPRESS=false", async () => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", validPayload());

    // P0-4: queue name must equal function_id (mem::compress), not bare "compress"
    const compressCalls = sdk.triggered.filter(
      (t) => t.id === "mem::compress",
    );
    expect(compressCalls.length).toBeGreaterThanOrEqual(1);

    // The Enqueue trigger must use queue name = function_id
    const enqueueCall = sdk.triggered.find(
      (t) =>
        t.id === "mem::compress" &&
        typeof t.raw === "object" &&
        t.raw !== null &&
        (t.raw as { action?: { type?: string; queue?: string } }).action?.type ===
          "enqueue",
    );
    expect(enqueueCall).toBeDefined();
    expect(
      (enqueueCall!.raw as { action: { type: string; queue: string } }).action
        .queue,
    ).toBe("mem::compress");
  });

  it("does not pass `raw` in the mem::compress trigger payload (Task 4 reads from KV)", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", validPayload());

    const compressCall = sdk.triggered.find((t) => t.id === "mem::compress");
    expect(compressCall).toBeDefined();
    const payload = compressCall!.data as Record<string, unknown>;
    // New shape: { observationId, sessionId } only — no `raw` field.
    expect(payload).not.toHaveProperty("raw");
    expect(payload).toHaveProperty("observationId");
    expect(payload).toHaveProperty("sessionId");
  });
});
