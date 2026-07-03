import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getAutoForgetIntervalMs } from "../src/config.js";

describe("getAutoForgetIntervalMs default fallback", () => {
  let origAuto: string | undefined;
  let origLegacy: string | undefined;

  beforeEach(() => {
    origAuto = process.env.AGENTMEMORY_AUTO_FORGET_INTERVAL;
    origLegacy = process.env.AUTO_FORGET_INTERVAL_MS;
    delete process.env.AGENTMEMORY_AUTO_FORGET_INTERVAL;
    delete process.env.AUTO_FORGET_INTERVAL_MS;
  });

  afterEach(() => {
    if (origAuto !== undefined) process.env.AGENTMEMORY_AUTO_FORGET_INTERVAL = origAuto;
    else delete process.env.AGENTMEMORY_AUTO_FORGET_INTERVAL;
    if (origLegacy !== undefined) process.env.AUTO_FORGET_INTERVAL_MS = origLegacy;
    else delete process.env.AUTO_FORGET_INTERVAL_MS;
  });

  it("returns 3,600,000 (1h) when no env var is set", () => {
    expect(getAutoForgetIntervalMs()).toBe(3_600_000);
  });

  it("respects explicit AGENTMEMORY_AUTO_FORGET_INTERVAL override", () => {
    process.env.AGENTMEMORY_AUTO_FORGET_INTERVAL = "1800000";
    expect(getAutoForgetIntervalMs()).toBe(1_800_000);
  });

  it("falls back to legacy AUTO_FORGET_INTERVAL_MS", () => {
    process.env.AUTO_FORGET_INTERVAL_MS = "600000";
    expect(getAutoForgetIntervalMs()).toBe(600_000);
  });

  it("prefers AGENTMEMORY_AUTO_FORGET_INTERVAL over legacy", () => {
    process.env.AGENTMEMORY_AUTO_FORGET_INTERVAL = "1000";
    process.env.AUTO_FORGET_INTERVAL_MS = "9999";
    expect(getAutoForgetIntervalMs()).toBe(1000);
  });
});