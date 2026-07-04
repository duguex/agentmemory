import { describe, it, expect } from "vitest";
import type { CompressedObservation, CompressionKind } from "../src/types.js";

describe("CompressedObservation.compressionKind", () => {
  it("accepts 'synthetic' value", () => {
    const obs: CompressedObservation = {
      id: "obs-1",
      sessionId: "sess-1",
      timestamp: "2026-07-04T00:00:00Z",
      type: "file_read",
      title: "test",
      facts: [],
      narrative: "",
      concepts: [],
      files: [],
      importance: 5,
      compressionKind: "synthetic",
      compressionVersion: 1,
    };
    expect(obs.compressionKind).toBe("synthetic");
  });

  it("accepts 'llm' value", () => {
    const obs: CompressedObservation = {
      id: "obs-2",
      sessionId: "sess-1",
      timestamp: "2026-07-04T00:00:00Z",
      type: "file_read",
      title: "test",
      facts: [],
      narrative: "",
      concepts: [],
      files: [],
      importance: 5,
      compressionKind: "llm",
      compressionVersion: 1,
    };
    expect(obs.compressionKind).toBe("llm");
  });
});