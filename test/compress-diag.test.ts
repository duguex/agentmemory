import { describe, it, expect } from "vitest";
import { truncateDiag } from "../src/functions/compress.js";

describe("compress diag helpers", () => {
  it("truncateDiag leaves short strings unchanged", () => {
    expect(truncateDiag("hello", 10)).toBe("hello");
  });

  it("truncateDiag appends overflow marker", () => {
    const s = "a".repeat(50);
    const out = truncateDiag(s, 10);
    expect(out.startsWith("aaaaaaaaaa")).toBe(true);
    expect(out).toContain("…(+40c)");
    expect(out.length).toBeLessThan(s.length);
  });
});
