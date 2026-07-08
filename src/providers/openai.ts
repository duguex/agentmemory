import type { MemoryProvider } from "../types.js";
import { getEnvVar } from "../config.js";
import { fetchWithTimeout } from "./_fetch.js";
import {
  DEFAULT_AZURE_API_VERSION,
  buildAuthHeaders,
  buildChatUrl,
  detectAzure,
  normalizeBaseUrl,
} from "./_openai-shared.js";

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * OpenAI-compatible LLM provider.
 *
 * Uses raw fetch (no SDK) to support any OpenAI-compatible endpoint:
 *   - OpenAI official
 *   - Azure OpenAI (auto-detected from .openai.azure.com host)
 *   - DeepSeek
 *   - 硅基流动 (SiliconFlow)
 *   - vLLM / LM Studio / Ollama (with OpenAI compatibility layer)
 *   - Any other proxy implementing /v1/chat/completions
 *
 * Required env vars:
 *   OPENAI_API_KEY  — API key
 *
 * Optional:
 *   OPENAI_BASE_URL          — base URL without path (default: https://api.openai.com).
 *                              Azure: https://<resource>.openai.azure.com/openai/deployments/<deployment>
 *   OPENAI_MODEL             — model name (default: gpt-4o-mini)
 *   OPENAI_API_VERSION       — Azure api-version query param (default: 2024-08-01-preview)
 *   OPENAI_TIMEOUT_MS        — outbound fetch timeout in ms (OpenAI-scoped alias,
 *                              takes precedence over AGENTMEMORY_LLM_TIMEOUT_MS
 *                              for back-compat with the v0.9.17 shipping name).
 *   AGENTMEMORY_LLM_TIMEOUT_MS — outbound fetch timeout in ms shared across all
 *                              raw-fetch LLM + embedding providers. Used when
 *                              OPENAI_TIMEOUT_MS is not set. Default: 60000.
 *   MAX_TOKENS               — max output tokens (default: from config or 4096)
 *   OPENAI_REASONING_EFFORT  — "low" | "medium" | "high" | "none"
 *                              Passthrough for reasoning models (e.g. Ollama Cloud
 *                              thinking models). Set to "none" to ensure
 *                              message.content is populated instead of only
 *                              message.reasoning.
 */
export class OpenAIProvider implements MemoryProvider {
  name = "openai";
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private baseUrl: string;
  private reasoningEffort?: string;
  private timeoutMs: number;
  private isAzure: boolean;
  private azureApiVersion: string;

  constructor(apiKey: string, model: string, maxTokens: number, baseURL?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens;
    this.baseUrl = normalizeBaseUrl(baseURL || getEnvVar("OPENAI_BASE_URL"));
    this.reasoningEffort = getEnvVar("OPENAI_REASONING_EFFORT") || undefined;
    this.timeoutMs = resolveTimeout();
    this.azureApiVersion =
      getEnvVar("OPENAI_API_VERSION") || DEFAULT_AZURE_API_VERSION;
    this.isAzure = detectAzure(this.baseUrl);
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt);
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt);
  }

  private async call(systemPrompt: string, userPrompt: string): Promise<string> {
    const url = buildChatUrl(this.baseUrl, this.isAzure, this.azureApiVersion);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      // temperature=0 reduces variance across runs — same input → same
      // output. For memory compression this is desirable: we want the
      // corpus to be stable across re-compression runs, not
      // re-roll-the-dice each time. Set OPENAI_TEMPERATURE > 0 to
      // override (useful for diverse reformulation in query expansion).
      temperature: parseTemperature(getEnvVar("OPENAI_TEMPERATURE")) ?? 0,
      // OpenAI API spec defines `stream` as defaulting to false, so omitting
      // it should yield a JSON response. Some OpenAI-compatible proxies
      // (notably 9Router < 0.4.56 — see decolua/9router#1260) default to
      // text/event-stream when `stream` is absent, which crashes the
      // `response.json()` call below with `Unexpected token 'd', "data: {"id"...`.
      // Send it explicitly so non-spec endpoints route to non-streaming too.
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };
    if (this.reasoningEffort) {
      body.reasoning_effort = this.reasoningEffort;
    }

    // Retry policy: 2 retries on 429/5xx with exponential backoff
    // (250ms, 1s). Timeouts and 4xx (except 429) are not retried —
    // they indicate a request-shape or input problem that won't fix
    // itself. The ResilientProvider circuit breaker still applies on
    // top: a string of failures opens the breaker and short-circuits
    // subsequent calls.
    const MAX_ATTEMPTS = 3;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
      }
      try {
        const result = await this.attemptCall(url, body);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const msg = lastError.message;
        const retriable =
          /timeout|timed out|429|5\d\d|fetch failed|ECONNRESET|ENOTFOUND/i.test(
            msg,
          );
        if (!retriable) throw lastError;
        // otherwise loop and retry
      }
    }
    throw lastError ?? new Error("OpenAI call failed without an error");
  }

  private async attemptCall(
    url: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    // Bound the request via the shared fetchWithTimeout helper, which
    // owns the AbortController + clearTimeout cleanup for every raw-fetch
    // provider (minimax, openrouter, gemini, openrouter-embed, etc.).
    // OPENAI_TIMEOUT_MS keeps its v0.9.17 meaning (OpenAI-scoped alias,
    // takes precedence); when unset we fall through to
    // AGENTMEMORY_LLM_TIMEOUT_MS and finally the 60s default. See #446.
    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: buildAuthHeaders(this.apiKey, this.isAzure),
          body: JSON.stringify(body),
        },
        this.timeoutMs,
      );
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      if (aborted) {
        throw new Error(
          `OpenAI API request timed out after ${this.timeoutMs}ms — set OPENAI_TIMEOUT_MS (or AGENTMEMORY_LLM_TIMEOUT_MS) to raise the bound or check the provider status.`,
        );
      }
      throw err;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string; reasoning?: string; reasoning_content?: string };
      }>;
    };
    const message = data.choices?.[0]?.message;
    const content = message?.content;
    if (content) {
      return content;
    }
    // Fallback: some thinking models return reasoning but no content.
    // DeepSeek V4 / Qwen3 / GLM / Kimi return `reasoning_content`;
    // older OpenAI o-series + some compatibles return `reasoning`. #627
    const reasoning = message?.reasoning ?? message?.reasoning_content;
    if (reasoning) {
      return reasoning;
    }
    throw new Error(
      `OpenAI returned unexpected response: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
}

function parseTemperature(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const trimmed = String(raw).trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  if (n < 0 || n > 2) return undefined; // OpenAI spec: 0..2
  return n;
}

// Resolves the outbound-fetch timeout for the OpenAI LLM path.
// Precedence (preserving v0.9.17 behaviour):
//   1. OPENAI_TIMEOUT_MS       — OpenAI-scoped alias (back-compat)
//   2. AGENTMEMORY_LLM_TIMEOUT_MS — global LLM/embedding timeout (#446)
//   3. 60 000 ms default
function resolveTimeout(): number {
  const openaiRaw = getEnvVar("OPENAI_TIMEOUT_MS");
  const openai = parsePositiveInt(openaiRaw);
  if (openai !== undefined) return openai;

  const globalRaw = getEnvVar("AGENTMEMORY_LLM_TIMEOUT_MS");
  const globalMs = parsePositiveInt(globalRaw);
  if (globalMs !== undefined) return globalMs;

  return DEFAULT_TIMEOUT_MS;
}

function parsePositiveInt(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  // Reject malformed values like "30ms" or "1_000" — parseInt would
  // silently return 30 / 1, swallowing user typos as valid timeouts.
  // The regex enforces pure digits (no sign, no trailing units, no
  // separators) before we hand off to Number.
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

