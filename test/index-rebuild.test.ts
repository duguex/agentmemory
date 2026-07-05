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

import { SearchIndex } from "../src/state/search-index.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import type { CompressedObservation, Session } from "../src/types.js";

function makeObs(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: "Edit auth middleware",
    subtitle: "JWT validation",
    facts: ["Added token check"],
    narrative: "Modified the auth middleware to validate JWT tokens",
    concepts: ["authentication", "jwt"],
    files: ["src/middleware/auth.ts"],
    importance: 7,
    ...overrides,
  };
}

function makeSession(id: string): Session {
  return {
    id,
    project: "demo",
    cwd: "/tmp/demo",
    startedAt: new Date().toISOString(),
    endedAt: null,
  } as Session;
}

describe("search-index-rebuild endpoint", () => {
  let sdk: any;
  let kv: any;
  let handler: any;
  let triggerConfig: { api_path: string; http_method: string } | null;

  beforeEach(() => {
    handler = undefined;
    triggerConfig = null;
    sdk = {
      registerFunction: vi.fn((id: string, h: any) => {
        if (id === "api::search-index-rebuild") handler = h;
      }),
      registerTrigger: vi.fn((cfg: any) => {
        if (cfg?.function_id === "api::search-index-rebuild") {
          triggerConfig = cfg.config;
        }
      }),
      trigger: vi.fn(),
    };
    // Minimal in-memory KV mock; each test overrides .list as needed.
    kv = {
      get: vi.fn(async () => null),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    };
    registerApiTriggers(sdk, kv);
  });

  it("registers a POST trigger at /agentmemory/search/rebuild", () => {
    expect(triggerConfig?.api_path).toBe("/agentmemory/search/rebuild");
    expect(triggerConfig?.http_method).toBe("POST");
    expect(typeof handler).toBe("function");
  });

  it("invokes rebuildIndex and returns the rebuilt count", async () => {
    // Provide 3 sessions, each with one observation, so rebuildIndex
    // counts 3 entries.
    const sessions: Session[] = [
      makeSession("ses_a"),
      makeSession("ses_b"),
      makeSession("ses_c"),
    ];
    kv.list.mockImplementation(async (scope: string) => {
      if (scope === "mem:sessions") return sessions;
      if (scope === "mem:obs:ses_a") {
        return [makeObs({ id: "obs_a", sessionId: "ses_a" })];
      }
      if (scope === "mem:obs:ses_b") {
        return [makeObs({ id: "obs_b", sessionId: "ses_b" })];
      }
      if (scope === "mem:obs:ses_c") {
        return [makeObs({ id: "obs_c", sessionId: "ses_c" })];
      }
      return [];
    });
    const result = await handler({ body: {}, headers: {} });
    expect(result.status_code).toBe(200);
    expect(result.body).toEqual({ rebuilt: 3 });
  });

  it("returns rebuilt: 0 when there are no sessions or memories", async () => {
    kv.list.mockResolvedValue([]);
    const result = await handler({ body: {}, headers: {} });
    expect(result.status_code).toBe(200);
    expect(result.body).toEqual({ rebuilt: 0 });
  });
});

describe("needsRebuild coverage heuristic (SearchIndex.getIndexedSessionIds)", () => {
  // These tests assert the data the boot-time heuristic relies on.
  // The full needsRebuild computation lives in src/index.ts and is
  // exercised by integration; here we cover the contract the index
  // must satisfy so the heuristic stays correct under add/remove.
  let index: SearchIndex;

  beforeEach(() => {
    index = new SearchIndex();
  });

  it("index with 0 sessions forces a rebuild (size === 0 path)", () => {
    expect(index.size).toBe(0);
    expect(index.getIndexedSessionIds().size).toBe(0);
  });

  it("index covering 1 of 10 actual sessions triggers rebuild (missingRatio > 0.1)", () => {
    // 9/10 = 90% missing → >10% threshold → rebuild.
    index.add(makeObs({ id: "obs_only", sessionId: "ses_present" }));
    const indexed = index.getIndexedSessionIds();
    const actual = Array.from({ length: 10 }, (_, i) =>
      makeSession(`ses_${i}`),
    ).map((s) => s.id);
    const missing = actual.filter((id) => !indexed.has(id));
    const missingRatio = missing.length / actual.length;
    expect(missingRatio).toBeGreaterThan(0.1);
  });

  it("index covering all sessions keeps rebuild off (missingRatio === 0)", () => {
    const sessions = ["ses_a", "ses_b", "ses_c"];
    sessions.forEach((id, i) =>
      index.add(makeObs({ id: `obs_${i}`, sessionId: id })),
    );
    const indexed = index.getIndexedSessionIds();
    const missing = sessions.filter((id) => !indexed.has(id));
    expect(missing.length / sessions.length).toBe(0);
  });
});