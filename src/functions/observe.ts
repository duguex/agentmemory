import { TriggerAction, type ISdk } from "iii-sdk";
import type { RawObservation, HookPayload } from "../types.js";
import { KV, STREAM, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { stripPrivateData } from "./privacy.js";
import { DedupMap } from "./dedup.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { isAutoCompressEnabled } from "../config.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import { getSearchIndex, vectorIndexAddGuarded } from "./search.js";
import { getAgentId } from "../config.js";
import { logger } from "../logger.js";
import { saveImageToDisk } from "../utils/image-store.js";

export function extractImage(d: unknown): string | undefined {
  if (!d) return undefined;
  if (typeof d === "string") {
    if (d.startsWith("data:image/") || d.startsWith("iVBORw0KGgo") || d.startsWith("/9j/")) {
      return d;
    }
    return undefined;
  }
  if (typeof d === "object" && d !== null) {
    const obj = d as Record<string, unknown>;
    if (typeof obj["image_data"] === "string") return obj["image_data"];
    if (typeof obj["image_path"] === "string") return obj["image_path"];
    if (typeof obj["imageBase64"] === "string") return obj["imageBase64"];
    if (typeof obj["imagePath"] === "string") return obj["imagePath"];

    for (const key of Object.keys(obj)) {
      const match = extractImage(obj[key]);
      if (match) return match;
    }
  }
  return undefined;
}

export function registerObserveFunction(
  sdk: ISdk,
  kv: StateKV,
  dedupMap?: DedupMap,
  maxObservationsPerSession?: number,
): void {
  sdk.registerFunction("mem::observe", 
    async (payload: HookPayload) => {

      if (
        !payload?.sessionId ||
        typeof payload.sessionId !== "string" ||
        !payload.hookType ||
        typeof payload.hookType !== "string" ||
        !payload.timestamp ||
        typeof payload.timestamp !== "string"
      ) {
        return {
          success: false,
          error:
            "Invalid payload: sessionId, hookType, and timestamp are required",
        };
      }

      const obsId = generateId("obs");

      let dedupHash: string | undefined;
      if (dedupMap) {
        const d =
          typeof payload.data === "object" && payload.data !== null
            ? (payload.data as Record<string, unknown>)
            : {};
        const toolName = (d["tool_name"] as string) || payload.hookType;
        dedupHash = dedupMap.computeHash(
          payload.sessionId,
          toolName,
          d["tool_input"],
        );
        if (dedupMap.isDuplicate(dedupHash)) {
          return { deduplicated: true, sessionId: payload.sessionId };
        }
      }

      let sanitizedRaw: unknown = payload.data;
      try {
        const jsonStr = JSON.stringify(payload.data);
        const sanitized = stripPrivateData(jsonStr);
        sanitizedRaw = JSON.parse(sanitized);
      } catch {
        sanitizedRaw = stripPrivateData(String(payload.data));
      }

      const raw: RawObservation = {
        id: obsId,
        sessionId: payload.sessionId,
        timestamp: payload.timestamp,
        hookType: payload.hookType,
        raw: sanitizedRaw,
      };

      let extractedImage: string | undefined;

      if (typeof sanitizedRaw === "object" && sanitizedRaw !== null) {
        const d = sanitizedRaw as Record<string, unknown>;
        if (
          payload.hookType === "post_tool_use" ||
          payload.hookType === "post_tool_failure"
        ) {
          raw.toolName = d["tool_name"] as string | undefined;
          raw.toolInput = d["tool_input"];
          raw.toolOutput = d["tool_output"] || d["error"];
        }
        if (payload.hookType === "prompt_submit") {
          raw.userPrompt = d["prompt"] as string | undefined;
        }

        extractedImage = extractImage(sanitizedRaw);
        if (extractedImage) {
          raw.modality = (raw.toolInput || raw.toolOutput || raw.userPrompt) ? "mixed" : "image";
        }
      } else if (typeof sanitizedRaw === "string") {
        extractedImage = extractImage(sanitizedRaw);
        if (extractedImage) {
          raw.modality = "image";
        }
      }

      const pendingImageData = extractedImage;

      return withKeyedLock(`obs:${payload.sessionId}`, async () => {
        // H1 fix: skip synthetic events with no real content. OMP fires
        // PostToolUse hooks for non-tool events (session::start, prompt_submit,
        // etc.) carrying empty toolInput/toolOutput and trivial userPrompt.
        // Without this filter, ~95% of corpus becomes "Synthetic observation
        // placeholder" entries that pollute search recall. We early-return
        // before any KV write, stream emit, dedup record, or compress enqueue.
        const hasRealContent =
          (typeof raw.toolInput === "string" && raw.toolInput.trim().length > 0) ||
          (raw.toolInput !== undefined &&
            raw.toolInput !== null &&
            typeof raw.toolInput !== "string" &&
            JSON.stringify(raw.toolInput).length > 2) ||
          (typeof raw.toolOutput === "string" && raw.toolOutput.trim().length > 0) ||
          (typeof raw.userPrompt === "string" && raw.userPrompt.trim().length > 5) ||
          (Array.isArray(raw.images) && raw.images.length > 0) ||
          pendingImageData !== undefined ||
          (typeof raw.toolName === "string" && raw.toolName.trim().length > 0);
        if (!hasRealContent) {
          logger.info("observe: skipping synthetic empty event", {
            sessionId: payload.sessionId,
            hookType: raw.hookType,
          });
          return { observationId: null, skipped: true, reason: "empty_content" };
        }

        if (maxObservationsPerSession && maxObservationsPerSession > 0) {
          const existing = await kv.list(KV.observations(payload.sessionId));
          if (existing.length >= maxObservationsPerSession) {
            return {
              success: false,
              error: `Session observation limit reached (${maxObservationsPerSession})`,
            };
          }
        }

        // Existing session is the source of truth for agentId (even
        // undefined). Env AGENT_ID only fires when no session row
        // exists yet — otherwise an unscoped session would get
        // retroactively scoped by a later AGENT_ID export.
        const existingSession = await kv.get<{
          agentId?: string;
          observationCount?: number;
          firstPrompt?: string;
        }>(KV.sessions, payload.sessionId);
        const inheritedAgentId = existingSession
          ? existingSession.agentId
          : getAgentId();
        if (inheritedAgentId) {
          raw.agentId = inheritedAgentId;
        }

        if (pendingImageData && (pendingImageData.startsWith("data:image/") || pendingImageData.startsWith("iVBORw0KGgo") || pendingImageData.startsWith("/9j/"))) {
          const { filePath, bytesWritten } = await saveImageToDisk(pendingImageData);
          raw.imageData = filePath;
          const { incrementImageRef } = await import("./image-refs.js");
          await incrementImageRef(kv, filePath);
          sdk.trigger({
            function_id: "mem::disk-size-delta",
            payload: { deltaBytes: bytesWritten },
            action: TriggerAction.Void(),
          });
          if (process.env["AGENTMEMORY_IMAGE_EMBEDDINGS"] === "true") {
            sdk.trigger({
              function_id: "mem::vision-embed",
              payload: {
                imageRef: filePath,
                sessionId: payload.sessionId,
                observationId: obsId,
              },
              action: TriggerAction.Void(),
            });
          }
        }

        try {

          await kv.set(KV.observations(payload.sessionId), obsId, raw);

        } catch (error) {
          if (raw.imageData) {
            // Roll back the ref taken above. decrementImageRef deletes the file
            // only when no other observation still references it (deduped images
            // survive) and emits the disk-size delta itself — deleting the file
            // directly here would orphan shared images and leave a stale ref.
            // If the rollback itself fails, log it but still surface the
            // original write error (the more useful failure to diagnose).
            try {
              const { decrementImageRef } = await import("./image-refs.js");
              await decrementImageRef(kv, sdk, raw.imageData);
            } catch (rollbackError) {
              logger.error("Failed to roll back image ref after observation write failure", {
                imageRef: raw.imageData,
                error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
              });
            }
          }
          throw error;
        }

        if (dedupMap && dedupHash) {
          dedupMap.record(dedupHash);
        }

        await sdk.trigger({
          function_id: "stream::set",
          payload: {
          stream_name: STREAM.name,
          group_id: STREAM.group(payload.sessionId),
          item_id: obsId,
          data: { type: "raw", observation: raw },
          },
        });

        await sdk.trigger({
          function_id: "stream::send",
          payload: {
            stream_name: STREAM.name,
            group_id: STREAM.viewerGroup,
            id: `raw-${obsId}`,
            type: "raw_observation",
            data: { type: "raw", observation: raw, sessionId: payload.sessionId },
          },
          action: TriggerAction.Void(),
        });

        const session = existingSession;
        if (session) {
          const updates: Array<{ type: "set"; path: string; value: unknown }> = [
            { type: "set", path: "updatedAt", value: new Date().toISOString() },
            {
              type: "set",
              path: "observationCount",
              value: (session.observationCount || 0) + 1,
            },
          ];
          if (!session.firstPrompt && typeof raw.userPrompt === "string") {
            const trimmed = raw.userPrompt.replace(/\s+/g, " ").trim();
            if (trimmed.length > 0) {
              updates.push({
                type: "set",
                path: "firstPrompt",
                value: trimmed.slice(0, 200),
              });
            }
          }
          await kv.update(KV.sessions, payload.sessionId, updates);
        } else if (
          typeof payload.project === "string" &&
          payload.project.trim().length > 0 &&
          typeof payload.cwd === "string" &&
          payload.cwd.trim().length > 0
        ) {
          // OpenCode (and any plugin that skips POST /session/start)
          // can fire observations before the session record exists. Without
          // an implicit create, those observations stack up but
          // `memory_sessions` never lists them, and summarize bails with
          // "Session not found for summarize". Create the session now from
          // the observation payload — but only when project + cwd are
          // present (HookPayload contract). Older test payloads without
          // those fields keep their original no-op behaviour.
          const trimmedPrompt =
            typeof raw.userPrompt === "string"
              ? raw.userPrompt.replace(/\s+/g, " ").trim().slice(0, 200)
              : undefined;
          const ts = new Date().toISOString();
          await kv.set(KV.sessions, payload.sessionId, {
            id: payload.sessionId,
            project: payload.project,
            cwd: payload.cwd,
            startedAt: payload.timestamp ?? ts,
            updatedAt: ts,
            status: "active",
            observationCount: 1,
            ...(inheritedAgentId ? { agentId: inheritedAgentId } : {}),
            ...(trimmedPrompt && trimmedPrompt.length > 0
              ? { firstPrompt: trimmedPrompt }
              : {}),
          });
        }

        // Step 1: Write synthetic unconditionally (immediate search availability)
        const synthetic = buildSyntheticCompression(raw);
        await kv.set(
          KV.observations(payload.sessionId),
          obsId,
          synthetic,
        );
        getSearchIndex().add(synthetic);
        await vectorIndexAddGuarded(
          synthetic.id,
          synthetic.sessionId,
          synthetic.title + " " + (synthetic.narrative || ""),
          { kind: "synthetic", logId: synthetic.id },
        );
        // P1-4: 2 次 stream::set（per-session group + viewer group，与现状一致）
        await sdk.trigger({
          function_id: "stream::set",
          payload: {
            stream_name: STREAM.name,
            group_id: STREAM.group(payload.sessionId),
            item_id: obsId,
            data: { type: "compressed", observation: synthetic },
          },
        });
        await sdk.trigger({
          function_id: "stream::set",
          payload: {
            stream_name: STREAM.name,
            group_id: STREAM.viewerGroup,
            item_id: obsId,
            data: {
              type: "compressed",
              observation: synthetic,
              sessionId: payload.sessionId,
            },
          },
        });

        // Step 2: Enqueue LLM upgrade unconditionally (gate lives in mem::compress now)
        await sdk.trigger({
          function_id: "mem::compress",
          payload: {
            observationId: obsId,
            sessionId: payload.sessionId,
          },
          action: TriggerAction.Enqueue({ queue: 'mem::compress' }),
        });

        logger.info("Observation captured", {
          obsId,
          sessionId: payload.sessionId,
          hook: payload.hookType,
          compress: isAutoCompressEnabled() ? "llm" : "synthetic",
        });
        return { observationId: obsId };
      });
    },
  );
}
