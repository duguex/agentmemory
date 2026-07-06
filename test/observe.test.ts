import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
    update: async (
      scope: string,
      key: string,
      updates: Array<{ path: string; value: unknown }>,
    ) => {
      const m = store.get(scope);
      if (!m) return;
      const v = (m.get(key) as Record<string, unknown>) ?? {};
      for (const u of updates) v[u.path] = u.value;
      m.set(key, v);
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

describe("observe.ts: empty event filter", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("skips synthetic event with empty toolInput/toolOutput/userPrompt (no images)", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_empty",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: {},
    })) as { observationId: string | null; skipped?: boolean; reason?: string };

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("empty_content");
    expect(result.observationId).toBeNull();

    // No observation should be written to KV
    const obsScope = kv.store.get("mem:obs:ses_empty");
    expect(obsScope?.has("obs-undefined")).toBeFalsy();

    // No compress enqueue should fire
    const compressCalls = sdk.triggered.filter((t) => t.id === "mem::compress");
    expect(compressCalls.length).toBe(0);
  });

  it("skips synthetic event with no toolName and trivial userPrompt", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_synth",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: {},
    })) as { observationId: string | null; skipped?: boolean; reason?: string };

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("empty_content");

    // No compress enqueue
    const compressCalls = sdk.triggered.filter((t) => t.id === "mem::compress");
    expect(compressCalls.length).toBe(0);
  });

  it("preserves a real tool call (Read with file_path)", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_real",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: {
        tool_name: "Read",
        tool_input: { file_path: "/tmp/x" },
        tool_output: "hello",
      },
    })) as { observationId: string | null; skipped?: boolean; reason?: string };

    expect(result.skipped).toBeFalsy();
    expect(result.observationId).toBeTruthy();

    // KV observation should exist
    const obsScope = kv.store.get("mem:obs:ses_real");
    expect(obsScope).toBeTruthy();
    expect(obsScope!.has(result.observationId as string)).toBe(true);

    // Compress should have been enqueued
    const compressCalls = sdk.triggered.filter((t) => t.id === "mem::compress");
    expect(compressCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("preserves a user prompt with real content (prompt_submit)", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_prompt",
      hookType: "prompt_submit",
      timestamp: new Date().toISOString(),
      data: {
        prompt: "what is the deployment process",
      },
    })) as { observationId: string | null; skipped?: boolean; reason?: string };

    expect(result.skipped).toBeFalsy();
    expect(result.observationId).toBeTruthy();

    const obsScope = kv.store.get("mem:obs:ses_prompt");
    expect(obsScope?.has(result.observationId as string)).toBe(true);
  });

  it("skips prompt_submit with too-short prompt", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_tiny",
      hookType: "prompt_submit",
      timestamp: new Date().toISOString(),
      data: {
        prompt: "hi",
      },
    })) as { observationId: string | null; skipped?: boolean; reason?: string };

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("empty_content");
  });

  it("preserves a tool call with bare toolName and no toolInput (back-compat for OMP bare tool events)", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_bare",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: {
        tool_name: "Read",
      },
    })) as { observationId: string | null; skipped?: boolean; reason?: string };

    expect(result.skipped).toBeFalsy();
    expect(result.observationId).toBeTruthy();

    const obsScope = kv.store.get("mem:obs:ses_bare");
    expect(obsScope?.has(result.observationId as string)).toBe(true);
  });
});