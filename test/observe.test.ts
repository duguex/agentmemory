import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Track every kv.set call so we can verify what was written.
function makeTrackedKV() {
  const inner = mockKV();
  const sets: Array<{ scope: string; key: string; value: unknown }> = [];
  const wrapped = {
    ...inner,
    store: inner.store,
    sets,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      sets.push({ scope, key, value: data });
      return inner.set(scope, key, data);
    },
    delete: inner.delete,
    update: inner.update,
    get: inner.get,
    list: inner.list,
  };
  return wrapped;
}

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

// Mock config.js so we can flip isAutoCompressEnabled() per test. The user's
// real ~/.agentmemory/.env often sets AGENTMEMORY_AUTO_COMPRESS=true, and
// config.ts reads it via loadEnvFile() — direct env mutations don't override
// the file-backed value. A module-level mock is the only reliable lever.
const acState = { enabled: false as boolean };
vi.mock("../src/config.js", () => ({
  isAutoCompressEnabled: () => acState.enabled,
  getAgentId: () => undefined,
  isAgentScopeIsolated: () => false,
}));

describe("observe.ts: AUTO_COMPRESS gating of raw vs synthetic write (#raw-preserve)", () => {
  beforeEach(() => {
    vi.resetModules();
    acState.enabled = false;
  });
  afterEach(() => {
    acState.enabled = false;
  });

  it("AGENTMEMORY_AUTO_COMPRESS=true + real tool data: writes raw observation to KV (not synthetic)", async () => {
    acState.enabled = true;
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = makeTrackedKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_raw_ac",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: {
        tool_name: "Read",
        tool_input: { file_path: "/tmp/x" },
        tool_output: "hello",
      },
    })) as { observationId: string };

    expect(result.observationId).toBeTruthy();
    const obsScope = kv.store.get("mem:obs:ses_raw_ac");
    expect(obsScope).toBeTruthy();
    const written = obsScope!.get(result.observationId) as Record<
      string,
      unknown
    >;

    // Raw observation signature: has toolName/toolInput/toolOutput, no
    // compressionKind field, no title/narrative/type (those belong to
    // CompressedObservation).
    expect(written.toolName).toBe("Read");
    expect(written.toolInput).toEqual({ file_path: "/tmp/x" });
    expect(written.toolOutput).toBe("hello");
    expect(written.compressionKind).toBeUndefined();
    expect(written.title).toBeUndefined();
    expect(written.narrative).toBeUndefined();

    // The final kv.set (overwrite-synthetic block) must have written the
    // raw payload. Earlier kv.set calls also write raw (pre-step-1), so
    // we verify the LAST write to that scope/key is raw.
    const finalSet = kv.sets
      .filter((s) => s.scope === "mem:obs:ses_raw_ac" && s.key === result.observationId)
      .pop();
    expect(finalSet).toBeTruthy();
    const finalVal = finalSet!.value as Record<string, unknown>;
    expect(finalVal.toolName).toBe("Read");
    expect(finalVal.compressionKind).toBeUndefined();
  });

  it("AGENTMEMORY_AUTO_COMPRESS=false (default) + real tool data: writes synthetic observation to KV", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = makeTrackedKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_synth_ac",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: {
        tool_name: "Read",
        tool_input: { file_path: "/tmp/x" },
        tool_output: "hello",
      },
    })) as { observationId: string };

    expect(result.observationId).toBeTruthy();
    const obsScope = kv.store.get("mem:obs:ses_synth_ac");
    expect(obsScope).toBeTruthy();
    const written = obsScope!.get(result.observationId) as Record<
      string,
      unknown
    >;

    // Synthetic signature: compressionKind="synthetic", has title/narrative.
    expect(written.compressionKind).toBe("synthetic");
    expect(typeof written.title).toBe("string");
    expect((written.title as string).length).toBeGreaterThan(0);

    // The final kv.set must be the synthetic version (raw got overwritten).
    const finalSet = kv.sets
      .filter(
        (s) => s.scope === "mem:obs:ses_synth_ac" && s.key === result.observationId,
      )
      .pop();
    expect(finalSet).toBeTruthy();
    const finalVal = finalSet!.value as Record<string, unknown>;
    expect(finalVal.compressionKind).toBe("synthetic");
  });

  it("AGENTMEMORY_AUTO_COMPRESS=true + empty synthetic event: H1 filter still skips (both branches agree)", async () => {
    acState.enabled = true;
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = makeTrackedKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_empty_ac",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: {},
    })) as {
      observationId: string | null;
      skipped?: boolean;
      reason?: string;
    };

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("empty_content");

    // No observation written — neither raw nor synthetic.
    const obsScope = kv.store.get("mem:obs:ses_empty_ac");
    expect(obsScope).toBeUndefined();

    // No mem::compress enqueue either.
    const compressCalls = sdk.triggered.filter((t) => t.id === "mem::compress");
    expect(compressCalls.length).toBe(0);
  });

  it("AGENTMEMORY_AUTO_COMPRESS=true: search/vector index NOT touched on the raw-write path (LLM writeback owns that)", async () => {
    acState.enabled = true;
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = makeTrackedKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_no_index",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: {
        tool_name: "Read",
        tool_input: { file_path: "/tmp/x" },
        tool_output: "hello",
      },
    })) as { observationId: string };

    // stream::set with type:"compressed" must NOT fire on the AUTO_COMPRESS=true
    // path — the LLM writeback in mem::compress owns those stream events.
    const compressedStreams = sdk.triggered.filter(
      (t) =>
        t.id === "stream::set" &&
        typeof t.data === "object" &&
        t.data !== null &&
        (t.data as Record<string, unknown>)["stream_name"] === "memory" &&
        JSON.stringify(t.data).includes('"compressed"'),
    );
    // No "compressed" type stream events should be emitted during the raw
    // observe path. The two stream::set events fire only on the synthetic branch.
    expect(compressedStreams.length).toBe(0);

    // The stream::send raw event still fires (real-time UI feed).
    const rawStreams = sdk.triggered.filter(
      (t) =>
        t.id === "stream::set" &&
        JSON.stringify(t.data).includes('"raw"'),
    );
    expect(rawStreams.length).toBeGreaterThanOrEqual(1);

    // KV observation must be raw (no compressionKind).
    const obsScope = kv.store.get("mem:obs:ses_no_index");
    const written = obsScope!.get(result.observationId) as Record<
      string,
      unknown
    >;
    expect(written.compressionKind).toBeUndefined();
    expect(written.toolName).toBe("Read");
  });
});