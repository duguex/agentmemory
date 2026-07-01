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

function authHeaders(): Record<string, string> {
	const h: Record<string, string> = { "Content-Type": "application/json" };
	const s = secret();
	if (s) h.Authorization = `Bearer ${s}`;
	return h;
}

async function apiPost<T>(path: string, body?: unknown): Promise<T | null> {
	try {
		const url = `${baseUrl().replace(/\/+$/, "")}/agentmemory/${path}`;
		const response = await fetch(url, {
			method: "POST",
			headers: authHeaders(),
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	}
}

async function apiGet<T>(path: string): Promise<T | null> {
	try {
		const url = `${baseUrl().replace(/\/+$/, "")}/agentmemory/${path}`;
		const response = await fetch(url, {
			method: "GET",
			headers: authHeaders(),
		});
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	}
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max) + "...";
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

// ── Extension factory ─────────────────────────────────────────────

export default function agentmemoryExtension(pi: ExtensionAPI) {
	let sessionId = `auto-${Date.now().toString(36)}`;
	let currentProject = process.cwd();
	let serverOk = false;

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
	let sessionInjected = false;

	// ── Session lifecycle hooks ─────────────────────────────────

	pi.on("session_start", async () => {
		sessionId = `auto-${Date.now().toString(36)}`;
		currentProject = process.cwd();
		sessionInjected = false;
		const result = await apiPost("session/start", { sessionId, project: currentProject, cwd: currentProject });
		serverOk = result !== null;
		const health = await apiGet("health");
		serverOk = health !== null;
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
			data: { tool_name: "user_prompt", tool_input: truncate(text, 2000) },
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

	// ── Session shutdown ──────────────────────────────────────

	pi.on("session_shutdown", async () => {
		if (!serverOk) return;
		void apiPost("session/end", { sessionId, reason: "shutdown" });
	});

	// ── Tool execution capture ──────────────────────────────────

	pi.on("tool_execution_start", async (event: unknown) => {
		if (!serverOk || !event || typeof event !== "object") return;
		const toolName = "toolName" in event ? String(event.toolName) : "unknown";
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

	pi.on("tool_execution_end", async (event: unknown) => {
		if (!serverOk || !event || typeof event !== "object") return;
		const toolName = "toolName" in event ? String(event.toolName) : "unknown";
		const toolResult = "result" in event ? JSON.stringify(event.result) : "";
		void apiPost("observe", {
			hookType: "post_tool_use",
			sessionId,
			project: currentProject,
			cwd: currentProject,
			timestamp: new Date().toISOString(),
			data: { tool_name: toolName, tool_output: truncate(toolResult, 2000) },
		});
	});

	// ── Memory injection via before_agent_start ───────────────

	pi.on("before_agent_start", async (event: unknown) => {
		if (!serverOk || sessionInjected || !event || typeof event !== "object") return;
		if (!("prompt" in event) || typeof event.prompt !== "string" || !event.prompt) return;
		sessionInjected = true;
		const result = await apiPost<{ results?: Array<{ title?: string; type?: string; narrative?: string }> }>(
			"smart-search",
			{ query: event.prompt, limit: 5 },
		);
		if (!result?.results?.length) return;
		const lines = result.results.map(
			(r) => `  [${r.type ?? "memory"}] ${r.title ?? ""}${r.narrative ? ` — ${r.narrative}` : ""}`,
		);
		const recallBlock = `## Recalled from memory\n${lines.join("\n")}`;
		if ("systemPrompt" in event && typeof event.systemPrompt === "string") {
			return { systemPrompt: event.systemPrompt + "\n\n" + recallBlock };
		}
		return { systemPrompt: recallBlock };
	});

	// ── Turn capture ───────────────────────────────────────────

	pi.on("turn_end", async (event: unknown) => {
		if (!serverOk || !event || typeof event !== "object") return;
		if (!("messages" in event) || !Array.isArray(event.messages)) return;
		for (const msg of [...event.messages].reverse()) {
			if (!msg || typeof msg !== "object") continue;
			if (!("role" in msg) || msg.role !== "assistant") continue;
			const text = getText("content" in msg ? msg.content : "");
			if (!text) break;
			void apiPost("observe", {
				hookType: "post_tool_use",
				sessionId,
				project: currentProject,
				cwd: currentProject,
				timestamp: new Date().toISOString(),
				data: { tool_name: "conversation", tool_output: truncate(text, 4000) },
			});
			break;
		}
	});

	// ── Session end (session_shutdown is the primary close) ──

	pi.on("agent_end", async () => {
		// no-op: session/end is sent by session_shutdown
	});
}
