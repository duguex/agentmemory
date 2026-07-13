import { describe, it, expect, beforeEach } from "vitest";
import {
  withLlmChatGate,
  getLlmGateStats,
  resetLlmGateForTests,
  isLlmGateEnabled,
  getLlmGateConcurrency,
} from "../src/providers/llm-gate.js";
import { ResilientProvider } from "../src/providers/resilient.js";
import type { MemoryProvider } from "../src/types.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  return Promise.withResolvers<T>();
}

async function tick(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
describe("llm-gate", () => {
  beforeEach(() => {
    delete process.env["AGENTMEMORY_LLM_GATE"];
    delete process.env["AGENTMEMORY_LLM_QUEUE"];
    // process.env overrides ~/.agentmemory/.env in getEnvVar merge — set
    // explicitly so local operator .env (e.g. CONCURRENCY=2) cannot leak.
    process.env["AGENTMEMORY_LLM_GATE_CONCURRENCY"] = "1";
    delete process.env["AGENTMEMORY_LLM_QUEUE_CONCURRENCY"];
    resetLlmGateForTests();
  });

  it("is enabled by default with concurrency 1", () => {
    expect(isLlmGateEnabled()).toBe(true);
    expect(getLlmGateConcurrency()).toBe(1);
  });

  it("can be disabled via AGENTMEMORY_LLM_GATE=false", () => {
    process.env["AGENTMEMORY_LLM_GATE"] = "false";
    expect(isLlmGateEnabled()).toBe(false);
  });

  it("reads concurrency from env and caps at 4", () => {
    process.env["AGENTMEMORY_LLM_GATE_CONCURRENCY"] = "2";
    expect(getLlmGateConcurrency()).toBe(2);
    process.env["AGENTMEMORY_LLM_GATE_CONCURRENCY"] = "99";
    expect(getLlmGateConcurrency()).toBe(4);
  });

  it("serializes concurrent chat calls when concurrency=1", async () => {
    const order: number[] = [];
    const holdA = deferred();
    const holdB = deferred();
    const aStarted = deferred();
    const bStarted = deferred();

    const a = withLlmChatGate(async () => {
      order.push(1);
      aStarted.resolve();
      await holdA.promise;
      order.push(2);
      return "a";
    });
    await aStarted.promise;
    expect(order).toEqual([1]);
    expect(getLlmGateStats().inFlight).toBe(1);

    const b = withLlmChatGate(async () => {
      order.push(3);
      bStarted.resolve();
      await holdB.promise;
      order.push(4);
      return "b";
    });
    await tick();
    expect(order).toEqual([1]);

    holdA.resolve();
    await a;
    await bStarted.promise;
    expect(order).toEqual([1, 2, 3]);

    holdB.resolve();
    expect(await b).toBe("b");
    expect(order).toEqual([1, 2, 3, 4]);
    expect(getLlmGateStats().inFlight).toBe(0);
  });

  it("allows two concurrent calls when concurrency=2", async () => {
    process.env["AGENTMEMORY_LLM_GATE_CONCURRENCY"] = "2";
    const holdA = deferred();
    const holdB = deferred();
    const bothStarted = deferred();
    let started = 0;

    const a = withLlmChatGate(async () => {
      started += 1;
      if (started === 2) bothStarted.resolve();
      await holdA.promise;
      return "a";
    });
    const b = withLlmChatGate(async () => {
      started += 1;
      if (started === 2) bothStarted.resolve();
      await holdB.promise;
      return "b";
    });

    await bothStarted.promise;
    expect(getLlmGateStats().inFlight).toBe(2);
    expect(getLlmGateStats().concurrency).toBe(2);

    holdA.resolve();
    holdB.resolve();
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
    expect(getLlmGateStats().inFlight).toBe(0);
  });

  it("ResilientProvider compress and summarize never overlap at concurrency 1", async () => {
    let maxConcurrent = 0;
    let current = 0;
    const hold = deferred();

    const inner: MemoryProvider = {
      name: "mock",
      async compress() {
        current += 1;
        maxConcurrent = Math.max(maxConcurrent, current);
        await hold.promise;
        current -= 1;
        return "c";
      },
      async summarize() {
        current += 1;
        maxConcurrent = Math.max(maxConcurrent, current);
        await hold.promise;
        current -= 1;
        return "s";
      },
    };

    const p = new ResilientProvider(inner);
    const a = p.compress("sys", "u");
    const b = p.summarize("sys", "u");
    await tick(20);
    expect(maxConcurrent).toBe(1);
    hold.resolve();
    await Promise.all([a, b]);
  });

  it("when disabled, calls may overlap", async () => {
    process.env["AGENTMEMORY_LLM_GATE"] = "false";
    let maxConcurrent = 0;
    let current = 0;
    const hold = deferred();
    const both = deferred();

    const run = () =>
      withLlmChatGate(async () => {
        current += 1;
        maxConcurrent = Math.max(maxConcurrent, current);
        if (current === 2) both.resolve();
        await hold.promise;
        current -= 1;
      });

    const a = run();
    const b = run();
    await both.promise;
    expect(maxConcurrent).toBe(2);
    hold.resolve();
    await Promise.all([a, b]);
  });
});
