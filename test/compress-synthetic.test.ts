import { describe, it, expect } from "vitest";
import { buildSyntheticCompression } from "../src/functions/compress-synthetic.js";
import type { RawObservation } from "../src/types.js";

describe("buildSyntheticCompression", () => {
  it("marks output as compressionKind: 'synthetic'", () => {
    const raw: RawObservation = {
      id: "obs-1",
      sessionId: "sess-1",
      timestamp: "2026-07-04T00:00:00Z",
      hookType: "PostToolUse",
      toolName: "Read",
      toolInput: { file_path: "/tmp/foo" },
      toolOutput: "contents",
      raw: {},
    };
    const compressed = buildSyntheticCompression(raw);
    expect(compressed.compressionKind).toBe("synthetic");
    expect(compressed.compressionVersion).toBe(1);
  });
});