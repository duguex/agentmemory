/**
 * agentmemory OMP extension — Oh My Pi integration.
 *
 * Uses a local ExtensionAPI interface instead of importing from either
 * @oh-my-pi/pi-coding-agent (OMP) or @mariozechner/pi-coding-agent (Pi)
 * so the same file loads in both runtimes without compile-time deps.
 */

import { Type } from "typebox";

// ── Local ExtensionAPI interface ──────────────────────────────
interface ExtensionAPI {
	on: (event: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => void;
	registerTool?: (...args: unknown[]) => unknown;
	registerCommand?: (...args: unknown[]) => unknown;
}

// ── Env vars (read at runtime, not module load time) ──────────
function baseUrl(): string {
	return process.env.AGENTMEMORY_URL ?? "http://localhost:3111";
}

function secret(): string {
	return process.env.AGENTMEMORY_SECRET ?? "";
}

// Warn if sending bearer token over plaintext HTTP (P2-015)
function maybeWarnPlaintextBearer(): void {
	const url = process.env.AGENTMEMORY_URL ?? "";
	if (!url.startsWith("http://")) return;
	if (!process.env.AGENTMEMORY_SECRET) return;
	if (url.includes("localhost") || url.includes("127.0.0.1") || url.includes("::1")) return;
	// Also allow private network IPs over plaintext (same security boundary)
	if (url.match(/https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/)) return;
	console.warn("[agentmemory] Sending bearer token over plaintext HTTP to " + url + ". Use https:// in production.");
}

maybeWarnPlaintextBearer();

function authHeaders(): Record<string, string> {
	const h: Record<string, string> = { "Content-Type": "application/json" };
	const s = secret();
	if (s) h.Authorization = `Bearer ${s}`;
	return h;
}

async function apiPost<T>(path: string, body?: unknown): Promise<T | null> {
	try {
		const base = baseUrl().replace(/\/+$/, "");
		const prefix = base.includes("/agentmemory") ? "/" : "/agentmemory/";
		const url = `${base}${prefix}${path}`;
		const response = await fetch(url, {
			method: "POST",
			headers: authHeaders(),
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(3000),
		});
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch (err) {
		console.warn(`[agentmemory] apiPost failed: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

async function apiGet<T>(path: string): Promise<T | null> {
	try {
		const base = baseUrl().replace(/\/+$/, "");
		const prefix = base.includes("/agentmemory") ? "/" : "/agentmemory/";
		const url = `${base}${prefix}${path}`;
		const response = await fetch(url, {
			method: "GET",
			headers: authHeaders(),
			signal: AbortSignal.timeout(3000),
		});
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch (err) {
		console.warn(`[agentmemory] apiGet failed: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

// P2-014: handle max<=0 and UTF-16 surrogate pairs
function truncate(s: string, max: number): string {
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
	let currentProject = process.cwd();
	let serverOk = false;
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
		currentProject = process.cwd();
		sessionInjected = false;
		// P1-011: single HTTP call, no separate health check
		const result = await apiPost("session/start", { sessionId, project: currentProject, cwd: currentProject });
		serverOk = result !== null;
	});

	// ── User prompt capture ────────────────────────────────────

	pi.on("turn_start", async (event: unknown) => {
		if (!serverOk || !event || typeof event !== "object") return;
		if (!("messages" in event) || !Array.isArray(event.messages)) return;
		const lastMsg = event.messages[event.messages.length - 1];
		if (!lastMsg || typeof lastMsg !== "object") return;
		if (!("role" in lastMsg) || lastMsg.role !== "user") return;
		const text = getText("content" in lastMsg ? lastMsg.content : "");
		if (!text) return;
		void apiPost("observe", {
			hookType: "prompt_submit",
			sessionId,
			project: currentProject,
			cwd: currentProject,
			timestamp: new Date().toISOString(),
			data: { tool_name: "user_prompt", tool_input: truncate(text, 2000), prompt: truncate(text, 500) },
		});
	});

	// ── Subagent tracking ─────────────────────────────────────

	pi.on("agent_start", async () => {
		if (!serverOk) return;
		void apiPost("observe", {
			hookType: "subagent_start",
			sessionId,
			project: currentProject,
			cwd: currentProject,
			timestamp: new Date().toISOString(),
			data: { tool_name: "subagent_start" },
		});
	});

	// ── Compaction tracking ───────────────────────────────────

	pi.on("auto_compaction_start", async () => {
		if (!serverOk) return;
		void apiPost("observe", {
			hookType: "pre_compact",
			sessionId,
			project: currentProject,
			cwd: currentProject,
			timestamp: new Date().toISOString(),
			data: { tool_name: "compaction_start" },
		});
	});

	// ── Session shutdown (always fires, even if server was down) ─

	pi.on("session_shutdown", async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 3000);
		await Promise.race([
			apiPost("session/end", { sessionId, reason: "shutdown" }),
			promise,
		]);
	});

	// ── Tool execution capture ──────────────────────────────────

	pi.on("tool_execution_start", async (event: unknown) => {
		if (!serverOk || !event || typeof event !== "object") return;
		const rawName = "toolName" in event ? event.toolName : undefined;
		const toolName = (typeof rawName === "string" && rawName.length > 0) ? rawName : "unknown";
		const toolInput = "input" in event ? JSON.stringify(event.input) : "";
		void apiPost("observe", {
			hookType: "pre_tool_use",
			sessionId,
			project: currentProject,
			cwd: currentProject,
			timestamp: new Date().toISOString(),
			data: { tool_name: toolName, tool_input: truncate(toolInput, 500) },
		});
	});

	// P1-008: check isError to distinguish success/failure
	pi.on("tool_execution_end", async (event: unknown) => {
		if (!serverOk || !event || typeof event !== "object") return;
		const rawName = "toolName" in event ? event.toolName : undefined;
		const toolName = (typeof rawName === "string" && rawName.length > 0) ? rawName : "unknown";
		const toolResult = "result" in event ? JSON.stringify(event.result) : "";
		const isError = "isError" in event ? !!event.isError : false;
		void apiPost("observe", {
			hookType: isError ? "post_tool_failure" : "post_tool_use",
			sessionId,
			project: currentProject,
			cwd: currentProject,
			timestamp: new Date().toISOString(),
			data: { tool_name: toolName, tool_output: truncate(toolResult, 2000), error: isError || undefined },
		});
	});

	// ── Memory injection via before_agent_start (P1-006: gated by AGENTMEMORY_INJECT_CONTEXT) ─

	pi.on("before_agent_start", async (event: unknown) => {
		if (!serverOk || sessionInjected || !event || typeof event !== "object") return;
		if (!isInjectContextEnabled()) return;
		if (!("prompt" in event) || typeof event.prompt !== "string" || !event.prompt) return;
		const result = await apiPost<{ results?: Array<{ title?: string; type?: string; narrative?: string }> }>(
			"search",
			{ query: event.prompt, limit: 5, format: "narrative" },
		);
		if (!result?.results?.length) return;
		sessionInjected = true;
		const lines = result.results.map(
			(r) => `  [${r.type ?? "memory"}] ${r.title ?? ""}${r.narrative ? ` — ${r.narrative}` : ""}`,
		);
		const recallBlock = `## Recalled from memory\n${lines.join("\n")}`;
		if ("systemPrompt" in event && typeof event.systemPrompt === "string") {
			return { systemPrompt: event.systemPrompt + "\n\n" + recallBlock };
		}
		return { systemPrompt: recallBlock };
	});

	// ── Turn capture (P1-009: hookType = "notification", not "post_tool_use") ──

	pi.on("turn_end", async (event: unknown) => {
		if (!serverOk || !event || typeof event !== "object") return;
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
				project: currentProject,
				cwd: currentProject,
				timestamp: new Date().toISOString(),
				data: { tool_name: "conversation", tool_output: truncate(text, 4000) },
			});
			break;
		}
	});

	// ── Session end (session_shutdown already sends session/end) ──

	pi.on("agent_end", async () => {
		// no-op: session/end is sent by session_shutdown
	});
}
