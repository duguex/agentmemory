/**
 * Process-wide gate for chat LLM calls (compress / summarize / describeImage).
 *
 * iii business queues still own async job lifecycle. This gate only limits
 * concurrent chat calls into local Qwen/Ollama so workers + sync paths do not
 * stampede the same model.
 *
 * Disable: AGENTMEMORY_LLM_GATE=false
 * Concurrency: AGENTMEMORY_LLM_GATE_CONCURRENCY=N (default 1, max 4)
 */

import { getEnvVar } from "../config.js";

let inFlight = 0;
let totalAcquired = 0;
const waiters: Array<() => void> = [];

export function isLlmGateEnabled(): boolean {
  const v =
    getEnvVar("AGENTMEMORY_LLM_GATE") ?? getEnvVar("AGENTMEMORY_LLM_QUEUE");
  if (v === undefined || v === "") return true;
  const lower = v.trim().toLowerCase();
  return lower !== "false" && lower !== "0" && lower !== "off" && lower !== "no";
}

/** Parallel chat slots. Default 1. Cap 4 for local GPU safety. */
export function getLlmGateConcurrency(): number {
  const raw =
    getEnvVar("AGENTMEMORY_LLM_GATE_CONCURRENCY") ??
    getEnvVar("AGENTMEMORY_LLM_QUEUE_CONCURRENCY");
  if (raw === undefined || raw === "") return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(4, n);
}

export function getLlmGateStats(): {
  enabled: boolean;
  inFlight: number;
  totalAcquired: number;
  concurrency: number;
} {
  return {
    enabled: isLlmGateEnabled(),
    inFlight,
    totalAcquired,
    concurrency: getLlmGateConcurrency(),
  };
}

/** Reset chain + counters (tests only). */
export function resetLlmGateForTests(): void {
  inFlight = 0;
  totalAcquired = 0;
  waiters.length = 0;
}

function acquireSlot(): Promise<void> {
  const limit = getLlmGateConcurrency();
  if (inFlight < limit) {
    inFlight += 1;
    totalAcquired += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      inFlight += 1;
      totalAcquired += 1;
      resolve();
    });
  });
}

function releaseSlot(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) next();
}

/** Run fn under the chat LLM concurrency limit. */
export async function withLlmChatGate<T>(fn: () => Promise<T>): Promise<T> {
  if (!isLlmGateEnabled()) {
    return fn();
  }

  await acquireSlot();
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}
