import type { MemoryProvider, CircuitBreakerState } from "../types.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { withLlmChatGate } from "./llm-gate.js";

export class ResilientProvider implements MemoryProvider {
  private breaker = new CircuitBreaker();
  name: string;

  constructor(private inner: MemoryProvider) {
    this.name = `resilient(${inner.name})`;
  }

  private async call(fn: () => Promise<string>): Promise<string> {
    // One chat call at a time process-wide (local Qwen shared GPU).
    return withLlmChatGate(async () => {
      if (!this.breaker.isAllowed) {
        throw new Error("circuit_breaker_open");
      }
      try {
        const result = await fn();
        this.breaker.recordSuccess();
        return result;
      } catch (err) {
        this.breaker.recordFailure();
        throw err;
      }
    });
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(() => this.inner.compress(systemPrompt, userPrompt));
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(() => this.inner.summarize(systemPrompt, userPrompt));
  }

  async describeImage(
    imageData: string,
    mimeType: string,
    prompt: string,
  ): Promise<string> {
    if (!this.inner.describeImage) {
      throw new Error(
        `Provider ${this.inner.name} does not support describeImage`,
      );
    }
    const describe = this.inner.describeImage.bind(this.inner);
    return this.call(() => describe(imageData, mimeType, prompt));
  }

  get circuitState(): CircuitBreakerState {
    return this.breaker.getState();
  }
}
