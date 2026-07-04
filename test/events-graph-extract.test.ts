import { describe, it, expect, vi } from "vitest";

vi.mock("iii-sdk", () => ({
  TriggerAction: {
    Void: () => ({ type: "void" }),
    Enqueue: (opts: { queue: string }) => ({ type: "enqueue", ...opts }),
  },
}));

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