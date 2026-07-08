import type { HybridSearchResult } from "../types.js";

let pipeline: any = null;
let pipelineLoading: Promise<any> | null = null;
let pipelineUnavailable = false;

const RERANK_TIMEOUT_MS = 250;
const MAX_CANDIDATES = 20;

async function loadPipeline(): Promise<any> {
  if (pipelineUnavailable) return null;
  if (pipeline) return pipeline;
  if (pipelineLoading) return pipelineLoading;

  pipelineLoading = (async () => {
    try {
      const { pipeline: createPipeline } = await import(
        "@xenova/transformers"
      );
      pipeline = await createPipeline(
        "text-classification",
        "Xenova/ms-marco-MiniLM-L-6-v2",
        { quantized: true },
      );
      return pipeline;
    } catch {
      pipeline = null;
      pipelineUnavailable = true;
      return null;
    } finally {
      pipelineLoading = null;
    }
  })();
  return pipelineLoading;
}

/**
 * Score a single (query, document) pair using the cross-encoder.
 *
 * The ms-marco-MiniLM model is a binary text-classifier trained on
 * (query, relevant?) pairs. The pipeline expects the text-classification
 * input shape:
 *
 *     { text: query, text_pair: document }
 *
 * The previous implementation concatenated them into a single string,
 * which fed the classifier "is this query+doc string relevant to
 * itself" — a meaningless score. The pair API produces a true
 * relevance score in [0, 1].
 */
async function scoreOne(
  reranker: any,
  query: string,
  doc: string,
): Promise<number> {
  const truncatedDoc = doc.length > 480 ? doc.slice(0, 480) : doc;
  try {
    const out = await Promise.race([
      reranker({ text: query, text_pair: truncatedDoc }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), RERANK_TIMEOUT_MS),
      ),
    ]);
    if (Array.isArray(out) && out.length > 0) {
      // Find the "true"/"relevant" label; default to first entry
      const relevantEntry =
        out.find((e: any) => /true|relevant|1|yes/i.test(e.label)) ?? out[0];
      return typeof relevantEntry?.score === "number"
        ? relevantEntry.score
        : 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

export async function rerank(
  query: string,
  results: HybridSearchResult[],
  topK = MAX_CANDIDATES,
): Promise<HybridSearchResult[]> {
  if (results.length <= 1) return results;

  const reranker = await loadPipeline();
  if (!reranker) return results; // Pipeline unavailable, return as-is

  const candidates = results.slice(0, Math.min(results.length, topK));

  // Score all candidates in parallel. Each pair gets a 250ms timeout;
  // on timeout we fall back to the existing combinedScore so a single
  // slow inference can't drag the whole rerank past its budget.
  const scored = await Promise.all(
    candidates.map(async (r) => {
      const docText = `${r.observation.title || ""} ${r.observation.narrative || ""}`.trim();
      const rerankScore = await scoreOne(reranker, query, docText);
      return { result: r, rerankScore };
    }),
  );

  scored.sort((a, b) => b.rerankScore - a.rerankScore);

  // Mix rerank score back with the original combinedScore (weighted
  // blend) so we don't fully discard a high-confidence vector hit
  // when the cross-encoder's score is noisy on a tight top-K. The
  // 70/30 blend keeps rerank as the dominant signal while
  // preventing catastrophic reordering.
  const RERANK_BLEND = 0.7;
  return scored.map((s, i) => ({
    ...s.result,
    combinedScore:
      s.rerankScore > 0
        ? RERANK_BLEND * s.rerankScore + (1 - RERANK_BLEND) * s.result.combinedScore
        : s.result.combinedScore,
    rerankPosition: i + 1,
  }));
}

export function isRerankerAvailable(): boolean {
  return pipeline !== null;
}
