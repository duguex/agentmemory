/**
 * agentmemory OMP extension — Oh My Pi integration.
 *
 * Uses a local ExtensionAPI interface instead of importing from either
 * @oh-my-pi/pi-coding-agent (OMP) or @mariozechner/pi-coding-agent (Pi)
 * so the same file loads in both runtimes without compile-time deps.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { CircuitBreaker } from "./circuit-breaker.js";

// ── Local ExtensionAPI interface ──────────────────────────────
interface ExtensionAPI {
	on: (event: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => void;
	registerTool?: (...args: unknown[]) => unknown;
	registerCommand?: (...args: unknown[]) => unknown;
}

// ── Env vars (read at runtime, not module load time) ──────────
// #70: process.env alone misses secrets that only live in
// ~/.agentmemory/.env (daemon loads that file; omp does not). Fall
// back so inject/health work when users only configured the daemon.

let cachedFileEnv: Record<string, string> | null = null;

function loadAgentmemoryFileEnv(): Record<string, string> {
	if (cachedFileEnv) return cachedFileEnv;
	const out: Record<string, string> = {};
	const p = join(homedir(), ".agentmemory", ".env");
	try {
		if (!existsSync(p)) {
			cachedFileEnv = out;
			return out;
		}
		for (const line of readFileSync(p, "utf-8").split("\n")) {
			const t = line.trim();
			if (!t || t.startsWith("#")) continue;
			const eq = t.indexOf("=");
			if (eq <= 0) continue;
			const key = t.slice(0, eq).trim();
			let val = t.slice(eq + 1).trim();
			if (
				(val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'"))
			) {
				val = val.slice(1, -1);
			}
			out[key] = val;
		}
	} catch {
		// ignore unreadable env
	}
	cachedFileEnv = out;
	return out;
}

function envOrFile(key: string): string | undefined {
	const fromProc = process.env[key];
	if (fromProc !== undefined && fromProc !== "") return fromProc;
	const fromFile = loadAgentmemoryFileEnv()[key];
	return fromFile !== undefined && fromFile !== "" ? fromFile : undefined;
}

function baseUrl(): string {
	return envOrFile("AGENTMEMORY_URL") ?? "http://localhost:3111";
}

function secret(): string {
	return envOrFile("AGENTMEMORY_SECRET") ?? "";
}


// #29: plaintext-bearer warn was originally called at module load
// time. The runtime version in authHeaders() is more accurate (it
// re-evaluates AGENTMEMORY_URL on every request, catching env vars
// set after import). The top-level call has been removed and so has
// the now-unused maybeWarnPlaintextBearer() helper.

function authHeaders(): Record<string, string> {
	const h: Record<string, string> = { "Content-Type": "application/json" };
	return withAuth(h);
}

// #28: GET requests with no body shouldn't advertise a Content-Type
// — some strict reverse proxies respond 400/415 to a GET that sends
// "Content-Type: application/json" without a body. Reuse the same
// auth + plaintext-bearer warning as the POST path.
function authHeadersForGet(): Record<string, string> {
	return withAuth({});
}

function withAuth(h: Record<string, string>): Record<string, string> {
	const s = secret();
	if (s) {
		h.Authorization = `Bearer ${s}`;
		// Re-evaluate plaintext bearer warning on every request
		const url = baseUrl();
		if (url.startsWith("http://")) {
			try {
				const u = new URL(url);
				const isPrivate = (h: string) =>
					h === "localhost" || h === "127.0.0.1" || h === "::1" ||
					h.startsWith("10.") || h.startsWith("192.168.") ||
					/^172\.(1[6-9]|2\d|3[01])\./.test(h);
				if (!isPrivate(u.hostname)) {
					console.warn(`[agentmemory] Sending bearer token over plaintext HTTP to ${url}`);
				}
			} catch {
				// invalid URL — skip
			}
		}
	}
	return h;
}

// ── Circuit breaker (CLOSED / OPEN / HALF_OPEN) ───────────────
const httpBreaker = new CircuitBreaker({ threshold: 5, cooldownMs: 60_000 });

async function apiPost<T>(path: string, body?: unknown): Promise<T | null> {
	try {
		if (!httpBreaker.canRequest()) return null;
		const base = baseUrl().replace(/\/+$/, "");
		const pathHasAgentMemory = /\/agentmemory\/?$/.test(new URL(base).pathname);
		const prefix = pathHasAgentMemory ? "/" : "/agentmemory/";
		const url = `${base}${prefix}${path}`;
		const response = await fetch(url, {
			method: "POST",
			headers: authHeaders(),
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(3000),
		});
		if (!response.ok) {
			httpBreaker.recordFailure();
			return null;
		}
		httpBreaker.recordSuccess();
		return (await response.json()) as T;
	} catch (err) {
		httpBreaker.recordFailure();
		console.warn(`[agentmemory] apiPost failed: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

async function apiGet<T>(path: string): Promise<T | null> {
	try {
		if (!httpBreaker.canRequest()) return null;
		const base = baseUrl().replace(/\/+$/, "");
		// #54: was `base.includes("/agentmemory")` — substring match
		// that misfires when the host itself contains "agentmemory"
		// (e.g. https://agentmemory.example.com would skip the
		// /agentmemory/ prefix). Use a proper path-segment check
		// instead: if the path already ends with /agentmemory or
		// /agentmemory/, no prefix; otherwise add /agentmemory/.
		const pathHasAgentMemory = /\/agentmemory\/?$/.test(new URL(base).pathname);
		const prefix = pathHasAgentMemory ? "/" : "/agentmemory/";
		const url = `${base}${prefix}${path}`;
		const response = await fetch(url, {
			method: "GET",
			headers: authHeadersForGet(),
			signal: AbortSignal.timeout(3000),
		});
		if (!response.ok) {
			httpBreaker.recordFailure();
			return null;
		}
		httpBreaker.recordSuccess();
		return (await response.json()) as T;
	} catch (err) {
		httpBreaker.recordFailure();
		console.warn(`[agentmemory] apiGet failed: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

// P2-014: handle max<=0 and UTF-16 surrogate pairs
function truncate(s: string, max: number): string {
	if (typeof s !== "string") return "";
	if (max <= 0) return "";
	if (s.length <= max) return s;
	let end = max;
	while (end > 0 && end < s.length) {
		const code = s.charCodeAt(end);
		if (code >= 0xdc00 && code <= 0xdfff) { end--; continue; }
		break;
	}
	return s.slice(0, end) + "...";
}

function getText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: unknown) => {
			if (!part || typeof part !== "object") return [];
			if ("type" in part && part.type === "text" && "text" in part && typeof part.text === "string") {
				return [part.text];
			}
			return [];
		})
		.join("\n")
		.trim();
}

// #53: JSON.stringify(error) returns "{}". Detect Error instances
// and serialize their message + stack so failures are searchable in
// the corpus. Otherwise fall back to plain JSON.stringify.
function stringifyResult(result: unknown): string {
	if (result === undefined || result === null) return "";
	if (result instanceof Error) {
		const out: Record<string, string> = {
			name: result.name,
			message: result.message,
		};
		if (result.stack) out.stack = result.stack;
		return JSON.stringify(out);
	}
	try {
		// JSON.stringify(undefined) returns undefined (not a string).
		return JSON.stringify(result) ?? "";
	} catch {
		// Circular ref or BigInt — fall back to a string repr.
		return String(result);
	}
}

function isInjectContextEnabled(): boolean {
	return process.env.AGENTMEMORY_INJECT_CONTEXT === "true";
}

// ── Extension factory ─────────────────────────────────────────────

function isSdkChild(): boolean {
	return process.env.AGENTMEMORY_SDK_CHILD === "1";
}

export default function agentmemoryExtension(pi: ExtensionAPI) {
	// Prevent recursive observation in subagents that inherit this extension
	if (isSdkChild()) return;
	let sessionId = `auto-${Date.now().toString(36)}`;
	// #21: do not pin project at session start — resolveProject() re-reads
	// cwd on every call so mid-session `cd` is reflected correctly.
	function resolveProject(): string {
		return process.env.AGENTMEMORY_PROJECT_NAME || process.cwd();
	}
	// #52: Promise.withResolvers polyfill holder. The setTimeout in
	// session_shutdown needs a resolver to race against apiPost; we
	// can't declare a local Promise in the handler (handlers can
	// re-enter), so hoist the resolver.
	let shutdownResolve: () => void = () => {};
	// #27 + #55: serverOk was a sticky latch — once false, every
	// subsequent hook was silently dropped for the rest of the session.
	// Replace with a TTL-cached health probe that's re-checked at most
	// every 5s, so a recovered daemon picks up traffic within seconds.
	let serverOk = false;
	let lastHealthCheckMs = 0;
	let lastHealthOk = false;
	const HEALTH_CHECK_INTERVAL_MS = 5000;
	async function ensureServerOk(): Promise<boolean> {
		const now = Date.now();
		if (now - lastHealthCheckMs < HEALTH_CHECK_INTERVAL_MS && lastHealthCheckMs !== 0) {
			return lastHealthOk;
		}
		lastHealthCheckMs = now;
		try {
			const health = await apiGet<{ status?: string; health?: { status?: string } }>("health");
			lastHealthOk = !!(health && (health.status === "healthy" || health.health?.status === "healthy"));
		} catch {
			lastHealthOk = false;
		}
		serverOk = lastHealthOk;
		return lastHealthOk;
	}
	let sessionInjected = false;

	// ── Tools ───────────────────────────────────────────────────

	pi.registerTool?.({
		name: "agentmemory_status",
		label: "AgentMemory Status",
		description: "Check whether the agentmemory server is reachable and healthy",
		parameters: Type.Object({}),
		execute: async () => {
			const health = await apiGet<{ status?: string; health?: { status?: string } }>("health");
			const ok = !!(health && (health.status === "healthy" || health.health?.status === "healthy"));
			serverOk = ok;
			return {
				content: [{ type: "text" as const, text: ok ? "agentmemory: healthy" : "agentmemory: unreachable" }],
			};
		},
	});

	pi.registerTool?.({
		name: "agentmemory_save",
		label: "AgentMemory Save",
		description: "Save a durable fact, decision, or observation into agentmemory",
		parameters: Type.Object({
			content: Type.String({ description: "What to remember" }),
			type: Type.Optional(Type.String({ description: "Type: fact, decision, milestone", default: "fact" })),
		}),
		execute: async (_id: string, params: { content: string; type?: string }) => {
			const content = params?.content ?? "";
			const result = await apiPost("remember", { content, type: params?.type ?? "fact" });
			return {
				content: [{ type: "text" as const, text: result ? `Saved: ${content}` : "Failed to save memory" }],
			};
		},
	});

	pi.registerTool?.({
		name: "agentmemory_search",
		label: "AgentMemory Search",
		description: "Search agentmemory for past sessions, decisions, and project context",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5, description: "Max results" })),
		}),
		execute: async (_id: string, params: { query: string; limit?: number }) => {
			const result = await apiPost<{ results?: Array<{ title?: string; type?: string }> }>("smart-search", {
				query: params?.query ?? "",
				limit: params?.limit ?? 5,
			});
			const items = result?.results ?? [];
			const text =
				items.length === 0
					? "No relevant memories found."
					: items.map((r, i) => `${i + 1}. [${r.type ?? "memory"}] ${r.title ?? "Untitled"}`).join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	});

	// ── Session lifecycle hooks ─────────────────────────────────

	pi.on("session_start", async () => {
		sessionId = `auto-${Date.now().toString(36)}`;
		// #21: resolveProject() reads cwd on every call so cd mid-session is tracked.
		sessionInjected = false;
		// P1-011: single HTTP call, no separate health check
		const project = resolveProject();
		const result = await apiPost("session/start", { sessionId, project, cwd: project });
		serverOk = result !== null;
	});

	// ── User prompt capture ────────────────────────────────────

	pi.on("turn_start", async (event: unknown) => {
		if (!(serverOk || (await ensureServerOk())) || !event || typeof event !== "object") return;
		if (!("messages" in event) || !Array.isArray(event.messages)) return;
		const lastMsg = event.messages[event.messages.length - 1];
		if (!lastMsg || typeof lastMsg !== "object") return;
		if (!("role" in lastMsg) || lastMsg.role !== "user") return;
		const text = getText("content" in lastMsg ? lastMsg.content : "");
		if (!text) return;
		void apiPost("observe", {
			hookType: "prompt_submit",
			sessionId,
			project: resolveProject(),
			cwd: resolveProject(),
			timestamp: new Date().toISOString(),
			data: { tool_name: "user_prompt", tool_input: truncate(text, 2000), prompt: truncate(text, 500) },
		});
	});

	// ── Subagent tracking ─────────────────────────────────────
	// #22: agent_start used to always tag as "subagent_start" — but
	// the very first agent_start in a session IS the main agent.
	// Track depth via a counter: the first start is the primary
	// agent, every subsequent nested one is a subagent. Reset on
	// session_start (already happens because sessionInjected=false).
	// #23: agent_end was a no-op. Add an emit that mirrors agent_start
	// so the corpus has matching start/end pairs for every agent.
	let agentDepth = 0;

	pi.on("agent_start", async () => {
		if (!(serverOk || (await ensureServerOk()))) return;
		const isMainAgent = agentDepth === 0;
		agentDepth++;
		void apiPost("observe", {
			hookType: isMainAgent ? "agent_start" : "subagent_start",
			sessionId,
			project: resolveProject(),
			cwd: resolveProject(),
			timestamp: new Date().toISOString(),
			data: { tool_name: isMainAgent ? "agent_start" : "subagent_start" },
		});
	});

	pi.on("agent_end", async () => {
		if (!(serverOk || (await ensureServerOk()))) return;
		const isMainAgent = agentDepth === 1;
		agentDepth = Math.max(0, agentDepth - 1);
		void apiPost("observe", {
			hookType: isMainAgent ? "agent_end" : "subagent_end",
			sessionId,
			project: resolveProject(),
			cwd: resolveProject(),
			timestamp: new Date().toISOString(),
			data: { tool_name: isMainAgent ? "agent_end" : "subagent_end" },
		});
	});

	// ── Compaction tracking ───────────────────────────────────

	pi.on("auto_compaction_start", async () => {
		if (!(serverOk || (await ensureServerOk()))) return;
		void apiPost("observe", {
			hookType: "pre_compact",
			sessionId,
			project: resolveProject(),
			cwd: resolveProject(),
			timestamp: new Date().toISOString(),
			data: { tool_name: "compaction_start" },
		});
	});

	// ── Session shutdown (always fires, even if server was down) ─

	pi.on("session_shutdown", async () => {
		// #52: Promise.withResolvers is Node 22+. We need to support
		// Node 18+ in the OMP integration. Inline a 4-line shim
		// that does the same thing without runtime branching.
		const promise = new Promise<void>((resolve) => { shutdownResolve = resolve; });
		// #56: .unref() so the engine can exit even if the server takes
		// >3s to respond. Without this, a slow agentmemory daemon blocks
		// the engine's exit by 3s.
		setTimeout(shutdownResolve, 3000).unref();
		await Promise.race([
			apiPost("session/end", { sessionId, reason: "shutdown" }),
			promise,
		]);
	});

	// ── Tool execution capture ──────────────────────────────────

	pi.on("tool_execution_start", async (event: unknown) => {
		if (!(serverOk || (await ensureServerOk())) || !event || typeof event !== "object") return;
		const rawName = "toolName" in event ? event.toolName : undefined;
		const toolName = (typeof rawName === "string" && rawName.length > 0) ? rawName : "unknown";
		const toolInput =
			"input" in event && event.input !== undefined && event.input !== null
				? JSON.stringify(event.input) ?? ""
				: "";
		void apiPost("observe", {
			hookType: "pre_tool_use",
			sessionId,
			project: resolveProject(),
			cwd: resolveProject(),
			timestamp: new Date().toISOString(),
			data: { tool_name: toolName, tool_input: truncate(toolInput, 500) },
		});
	});

	// P1-008: check isError to distinguish success/failure
	pi.on("tool_execution_end", async (event: unknown) => {
		if (!(serverOk || (await ensureServerOk())) || !event || typeof event !== "object") return;
		const rawName = "toolName" in event ? event.toolName : undefined;
		const toolName = (typeof rawName === "string" && rawName.length > 0) ? rawName : "unknown";
		// #53: JSON.stringify on a raw Error returns "{}" because
		// Error.message and .stack are non-enumerable. Detect Error
		// instances and serialize their message + stack explicitly so
		// failures are searchable in the corpus.
		const toolResult =
			"result" in event ? stringifyResult(event.result) : "";
		const isError = "isError" in event ? !!event.isError : false;
		void apiPost("observe", {
			hookType: isError ? "post_tool_failure" : "post_tool_use",
			sessionId,
			project: resolveProject(),
			cwd: resolveProject(),
			timestamp: new Date().toISOString(),
			data: { tool_name: toolName, tool_output: truncate(toolResult, 2000), error: isError || undefined },
		});
	});

	// ── Memory injection via before_agent_start (P1-006: gated by AGENTMEMORY_INJECT_CONTEXT) ─

	pi.on("before_agent_start", async (event: unknown) => {
		const dbgOn = process.env.AGENTMEMORY_INJECT_DEBUG === "true";
		const dbg = (m: string) => {
			if (dbgOn) console.error(`[agentmemory:inject] ${m}`);
		};
		// Check inject gate before health probe (#70: avoid silent skip).
		if (!isInjectContextEnabled()) {
			dbg("skip: INJECT_CONTEXT not true");
			return;
		}
		if (sessionInjected || !event || typeof event !== "object") {
			dbg(`skip early sessionInjected=${sessionInjected}`);
			return;
		}
		if (!(serverOk || (await ensureServerOk()))) {
			// #70: visible without DEBUG — once per agent start path
			console.warn(
				"[agentmemory] inject skipped: daemon health failed (check AGENTMEMORY_URL / AGENTMEMORY_SECRET in omp env or ~/.agentmemory/.env; set AGENTMEMORY_INJECT_DEBUG=true for detail)",
			);
			dbg("skip: serverOk false after ensureServerOk");
			return;
		}
		if (!("prompt" in event) || typeof event.prompt !== "string" || !event.prompt) {
			dbg("skip: no prompt on event");
			return;
		}
		dbg(`search query len=${event.prompt.length}`);
		const result = await apiPost<{ results?: Array<{ title?: string; type?: string; narrative?: string }> }>(
			"search",
			{ query: event.prompt, limit: 5, format: "narrative" },
		);
		if (!result?.results?.length) {
			dbg(`skip: empty search result=${result === null ? "null" : "no results"}`);
			return;
		}
		sessionInjected = true;
		const lines = result.results.map(
			(r) => `  [${r.type ?? "memory"}] ${r.title ?? ""}${r.narrative ? ` — ${r.narrative}` : ""}`,
		);
		const recallBlock = `## Recalled from memory\n${lines.join("\n")}`;
		dbg(`inject ok lines=${lines.length}`);
		const existing = ("systemPrompt" in event && typeof event.systemPrompt === "string")
			? event.systemPrompt.trim()
			: "";
		if (existing) {
			return { systemPrompt: `${existing}\n\n${recallBlock}` };
		}
		return { systemPrompt: recallBlock };
	});

	// ── Turn capture (P1-009: hookType = "notification", not "post_tool_use") ──

	pi.on("turn_end", async (event: unknown) => {
		if (!(serverOk || (await ensureServerOk())) || !event || typeof event !== "object") return;
		if (!("messages" in event) || !Array.isArray(event.messages)) return;
		// P2-013: iterate in-place instead of cloning the array
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const msg = event.messages[i];
			if (!msg || typeof msg !== "object") continue;
			if (!("role" in msg) || msg.role !== "assistant") continue;
			const text = getText("content" in msg ? msg.content : "");
			if (!text) break;
			void apiPost("observe", {
				hookType: "notification",
				sessionId,
				project: resolveProject(),
				cwd: resolveProject(),
				timestamp: new Date().toISOString(),
				data: { tool_name: "conversation", tool_output: truncate(text, 4000) },
			});
			break;
		}
	});

	// ── Session end (session_shutdown already sends session/end) ──
}
