import { TriggerAction, type ISdk } from "iii-sdk";
import { readFileSync } from "node:fs";
import { isManagedImagePath } from "../utils/image-store.js";
import type {
  RawObservation,
  CompressedObservation,
  ObservationType,
  MemoryProvider,
} from "../types.js";
import { KV, STREAM } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import {
  COMPRESSION_SYSTEM,
  buildCompressionPrompt,
} from "../prompts/compression.js";
import { VISION_DESCRIPTION_PROMPT } from "../prompts/vision.js";
import { getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { getSearchIndex, vectorIndexAddGuarded } from "./search.js";
import { CompressOutputSchema } from "../eval/schemas.js";
import { validateOutput } from "../eval/validator.js";
import { scoreCompression } from "../eval/quality.js";
import { compressWithRetry } from "../eval/self-correct.js";
import type { MetricsStore } from "../eval/metrics-store.js";
import { logger } from "../logger.js";
import { isAutoCompressEnabled } from "../config.js";

const VALID_TYPES = new Set<string>([
  "file_read",
  "file_write",
  "file_edit",
  "command_run",
  "search",
  "web_fetch",
  "conversation",
  "error",
  "decision",
  "discovery",
  "subagent",
  "notification",
  "task",
  "image",
  "other",
]);

function parseCompressionXml(
  xml: string,
): Omit<CompressedObservation, "id" | "sessionId" | "timestamp"> | null {
  const rawType = getXmlTag(xml, "type");
  const title = getXmlTag(xml, "title");
  if (!rawType || !title) return null;
  const type = VALID_TYPES.has(rawType) ? rawType : "other";

  return {
    type: type as ObservationType,
    title,
    subtitle: getXmlTag(xml, "subtitle") || undefined,
    facts: getXmlChildren(xml, "facts", "fact"),
    narrative: getXmlTag(xml, "narrative"),
    concepts: getXmlChildren(xml, "concepts", "concept"),
    files: getXmlChildren(xml, "files", "file"),
    importance: Math.max(
      1,
      Math.min(10, parseInt(getXmlTag(xml, "importance") || "5", 10) || 5),
    ),
  };
}

export function registerCompressFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
  metricsStore?: MetricsStore,
): void {
  sdk.registerFunction("mem::compress",
    async (data: {
      observationId: string;
      sessionId: string;
    }) => {
      const startMs = Date.now();

      // Read raw from KV by ID at drain time. The caller no longer passes
      // `raw` in the payload — the queue/scheduler may run this handler
      // minutes (or days, for backfill) after the original observation was
      // written. Reading from KV at start avoids a stale-write window where
      // the payload contained data newer than what's now persisted.
      const raw = await kv.get<RawObservation | CompressedObservation>(
        KV.observations(data.sessionId),
        data.observationId,
      );
      if (!raw) {
        throw new Error(`observation not found: ${data.observationId}`);
      }

      // P1-1 guard: already LLM-compressed → skip. Synthetic observations
      // (compressionKind === "synthetic") fall through; everything tagged
      // "llm" has already been through this code path and re-running would
      // waste tokens and overwrite better-tuned fields.
      if ((raw as CompressedObservation).compressionKind === "llm") {
        return {
          success: false,
          skipped: true,
          reason: "already LLM-compressed",
        };
      }

      // P0-1 guard: AUTO_COMPRESS=false → skip LLM call. The drain-time
      // design makes this safe to short-circuit: callers (observe.ts /
      // api::compress) gate auto-compress elsewhere, but the ingest-time
      // queue may still deliver a pending observation after the user
      // disabled the feature. We refuse to spend tokens here rather than
      // risk silent re-compression.
      if (!isAutoCompressEnabled()) {
        return {
          success: false,
          skipped: true,
          reason: "auto-compress disabled",
        };
      }

      let imageDescription: string | undefined;
      const hasImage = raw.modality === "image" || raw.modality === "mixed";

      if (hasImage && raw.imageData && provider.describeImage) {
        try {
          let base64Data = raw.imageData;
          let mimeType = "image/png";

          if (!raw.imageData.startsWith("/9j/") && !raw.imageData.startsWith("iVBOR")) {
            if (!isManagedImagePath(raw.imageData)) {
              throw new Error(`Refusing to read image outside managed store: ${raw.imageData}`);
            }
            const fileBuffer = readFileSync(raw.imageData);
            base64Data = fileBuffer.toString("base64");
            if (raw.imageData.endsWith(".jpg") || raw.imageData.endsWith(".jpeg")) mimeType = "image/jpeg";
            else if (raw.imageData.endsWith(".webp")) mimeType = "image/webp";
            else if (raw.imageData.endsWith(".gif")) mimeType = "image/gif";
          }

          imageDescription = await provider.describeImage(base64Data, mimeType, VISION_DESCRIPTION_PROMPT);
          logger.info("Image described by vision model", { obsId: data.observationId });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Vision model call failed, falling back to text-only compression", {
            obsId: data.observationId,
            error: msg,
          });
        }
      }

      // P0-9: a synthetic CompressedObservation (built by
      // buildSyntheticCompression) does not carry a hookType field. Fall
      // back to "synthetic" so buildCompressionPrompt has at least a
      // non-undefined hookType rather than crashing on the enum.
      const prompt = buildCompressionPrompt({
        hookType: (raw as RawObservation).hookType ?? "synthetic",
        toolName: (raw as RawObservation).toolName,
        toolInput: (raw as RawObservation).toolInput,
        toolOutput: imageDescription
          ? `[Image Description]: ${imageDescription}\n\n${(raw as RawObservation).toolOutput ?? ""}`
          : (raw as RawObservation).toolOutput,
        userPrompt: (raw as RawObservation).userPrompt,
        timestamp: raw.timestamp,
      });

      try {
        const validator = (response: string) => {
          const parsed = parseCompressionXml(response);
          if (!parsed) return { valid: false, errors: ["xml_parse_failed"] };
          const result = validateOutput(
            CompressOutputSchema,
            parsed,
            "mem::compress",
          );
          return result.valid
            ? { valid: true }
            : { valid: false, errors: result.result.errors };
        };

        // P0-7: capture `retried` so parse-failed warn logs surface
        // whether the validator bounced at least once before giving up.
        const { response, retried } = await compressWithRetry(
          provider,
          COMPRESSION_SYSTEM,
          prompt,
          validator,
          1,
        );

        const parsed = parseCompressionXml(response);
        if (!parsed) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::compress", latencyMs, false);
          }
          logger.warn("Failed to parse compression XML", {
            obsId: data.observationId,
            retried,
          });
          return { success: false, error: "parse_failed" };
        }

        const qualityScore = scoreCompression(parsed);

        // P0-5: write back with EXPLICIT compressionKind "llm" and
        // compressionVersion 1. Downstream filters (mem::search,
        // mem::graph-extract, viewer) rely on these fields to distinguish
        // LLM-authored summaries from synthetic ones.
        const compressed: CompressedObservation = {
          id: data.observationId,
          sessionId: data.sessionId,
          timestamp: raw.timestamp,
          ...parsed,
          confidence: qualityScore / 100,
          ...(hasImage ? { modality: raw.modality } : {}),
          ...(imageDescription ? { imageDescription } : {}),
          ...(raw.imageData ? { imageRef: raw.imageData } : {}),
          ...(raw.agentId ? { agentId: raw.agentId } : {}),
          compressionKind: "llm",
          compressionVersion: 1,
        };

        // P0-2 fix: runtime guard before writeback. iii-engine's state::set
        // has been observed silently stripping the new fields when the TypeScript
        // type marked them as required; this assertion catches any future
        // regression where the field set gets pruned upstream of this function.
        if (!compressed.compressionKind || !compressed.compressionVersion) {
          logger.error("Compression marker missing before writeback", {
            obsId: data.observationId,
            compressionKind: compressed.compressionKind,
            compressionVersion: compressed.compressionVersion,
          });
          return { success: false, error: "compression_marker_missing" };
        }

        // Bypass iii-engine v0.11.2 per-key schema lock on overwrite:
        // delete-then-set makes the kv.set look like a first-write, so
        // new fields (compressionKind, compressionVersion) are preserved.
        // Without this, LLM upgrade silently drops the discriminator field,
        // leaving observations stuck at "synthetic" forever.
        await kv.delete(
          KV.observations(data.sessionId),
          data.observationId,
        );
        await kv.set(
          KV.observations(data.sessionId),
          data.observationId,
          compressed,
        );

        try {
          getSearchIndex().add(compressed);
        } catch (err) {
          logger.warn("Failed to index compressed observation into BM25", {
            obsId: compressed.id,
            sessionId: compressed.sessionId,
            title: compressed.title,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // P0-A: vector-index kind MUST remain "observation". The
        // `kind` field is a filter key — downstream callers (search,
        // re-ranking) enumerate indexed items by kind to decide whether
        // to merge them into the result set. Renaming to "llm" here
        // would silently break those filters and orphan every
        // LLM-compressed item in the vector index.
        await vectorIndexAddGuarded(
          compressed.id,
          compressed.sessionId,
          compressed.title + " " + (compressed.narrative || ""),
          { kind: "observation", logId: compressed.id },
        );

        // P0-A: TWO stream triggers required (matches original lines
        // 222-234). The first targets the per-session group (drives
        // session-scoped observers). The second targets the
        // STREAM.viewerGroup via stream::send, which is the dedicated
        // path the viewer UI subscribes to. Skipping either one yields
        // an invisible compression: persisted in KV + indexes, but never
        // reaches the live consumers.
        const streamResults = await Promise.allSettled([
          sdk.trigger({
            function_id: "stream::set",
            payload: {
              stream_name: STREAM.name,
              group_id: STREAM.group(data.sessionId),
              item_id: data.observationId,
              data: { type: "compressed", observation: compressed },
            },
          }),
          sdk.trigger({
            function_id: "stream::send",
            payload: {
              stream_name: STREAM.name,
              group_id: STREAM.viewerGroup,
              id: `compressed-${data.observationId}`,
              type: "compressed_observation",
              data: {
                type: "compressed",
                observation: compressed,
                sessionId: data.sessionId,
              },
            },
            action: TriggerAction.Void(),
          }),
        ]);
        for (const result of streamResults) {
          if (result.status === "rejected") {
            logger.warn("Non-fatal stream publish failure after compress", {
              sessionId: data.sessionId,
              observationId: data.observationId,
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            });
          }
        }

        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record(
            "mem::compress",
            latencyMs,
            true,
            qualityScore,
          );
        }

        logger.info("Observation compressed", {
          obsId: data.observationId,
          type: compressed.type,
          importance: compressed.importance,
          qualityScore,
          retried,
        });

        return { success: true, compressed, qualityScore };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record("mem::compress", latencyMs, false);
        }
        logger.error("Compression failed", {
          obsId: data.observationId,
          error: msg,
        });
        return { success: false, error: "compression_failed" };
      }
    },
  );
}
