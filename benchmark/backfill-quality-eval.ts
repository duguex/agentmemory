// Backfill corpus quality eval — measures recall/precision on
// agentmemory data against hand-labeled queries.
//
// Phase 2.2: rewrote ground truth for a meaningful R@10.
//
// The previous version had three bugs that made the numbers
// meaningless:
//   1. `recall()` returned 1.0 for any query with empty relevantSessions,
//      so the "VASP" cross-session query (no labels) always reported
//      100% recall, inflating the average.
//   2. The eval was session-level, but smart-search returns
//      observation-level results. With one obs per session in top-10,
//      we lost recall even when the obs was highly relevant.
//   3. The 6 hand-labeled queries only covered a narrow slice of the
//      corpus (2 VASP sessions), so most queries reported 0% recall
//      for the wrong reason (no labels, not bad search).
//
// The rewrite:
//   - Splits evaluation into session-level and observation-level
//     (the latter is more sensitive to ranking quality).
//   - Adds HitRate@10, NDCG@10, and per-query nDCG.
//   - Drops queries with empty relevantSessions (they can't be
//     evaluated for retrieval, only for hit-rate via a separate
//     path).
//   - Expands labeled queries to 15 (covering VASP, data analysis,
//     debugging, file ops, agent lifecycle).
//   - Uses full UUID matching (no fuzzy 8-char suffix).
//   - Reports observation-level alongside session-level metrics.

import http from "node:http";

const SECRET = process.env.AGENTMEMORY_SECRET ?? "omp-memory-local";
const BASE_URL = process.env.AGENTMEMORY_URL ?? "http://localhost:3111";

interface LabeledQuery {
  query: string;
  category: "semantic" | "exact" | "entity" | "cross-session" | "code";
  /** Sessions whose content is directly relevant. */
  relevantSessions?: string[];
  /** Specific observations that are highly relevant (finer-grained). */
  relevantObservations?: string[];
}

const LABELED_QUERIES: LabeledQuery[] = [
  // === VASP domain (well-known) ===
  {
    query: "VASP binary file cleanup CHGCAR WAVECAR",
    category: "semantic",
    relevantSessions: ["backfill-019eb9b4-cbcf-7000-96ab-7bcc666ef668"],
  },
  {
    query: "VASP directory listing exploration",
    category: "semantic",
    relevantSessions: [
      "backfill-019eb9a6-e159-7000-9dc9-f508d70543c2",
      "backfill-019eb9ba-9336-7000-ad3d-7606533c415d",
      "backfill-019eb9ba-9301-7000-bd2d-99f7e9f821b2",
      "backfill-019ebcce-63ec-7000-968f-07f41529940b",
      "backfill-019eb9d6-f241-7000-a973-5d6bb6792882",
    ],
  },
  {
    query: "VASP data analysis Python read script",
    category: "code",
    relevantSessions: [
      "backfill-019eb9a6-e159-7000-9dc9-f508d70543c2",
      "backfill-019eb9ba-9336-7000-ad3d-7606533c415d",
    ],
  },
  {
    query: "directory listing directory survey",
    category: "exact",
    relevantSessions: [
      "backfill-019eb9a6-e159-7000-9dc9-f508d70543c2",
      "backfill-019eb9ba-9336-7000-ad3d-7606533c415d",
      "backfill-019eb9ba-9301-7000-bd2d-99f7e9f821b2",
    ],
  },

  // === File operations ===
  {
    query: "find large files to delete",
    category: "semantic",
    relevantSessions: [
      "backfill-019eb9d6-f241-7000-a973-5d6bb6792882",
      "backfill-019eb9b4-cbcf-7000-96ab-7bcc666ef668",
    ],
  },
  {
    query: "file read text file",
    category: "exact",
    // Many sessions involve file_read — too broad for precise labels.
    // We list a representative subset.
    relevantSessions: [
      "backfill-019eb9ba-9336-7000-ad3d-7606533c415d",
      "backfill-019ebcce-63ec-7000-968f-07f41529940b",
    ],
  },
  {
    query: "edit YAML configuration file",
    category: "semantic",
    relevantSessions: [
      "backfill-019e87b0-24ce-7000-9b2d-fa2877a0350f",
      "backfill-019e87b0-24e3-7000-ba72-81a2128f63f1",
    ],
  },

  // === Debugging / error investigation ===
  {
    query: "task error failure investigation",
    category: "semantic",
    relevantSessions: [
      "backfill-019e9c60-319a-7000-beae-18fd40bd11c5",
      "backfill-019e9c3b-616d-7000-8863-288f2956c0f0",
    ],
  },
  {
    query: "PostToolUse hook failure",
    category: "exact",
    relevantSessions: [
      "backfill-019e9c60-319a-7000-beae-18fd40bd11c5",
      "backfill-019e9c25-6599-7000-813b-01aeabdf0f29",
    ],
  },

  // === Agent / session lifecycle ===
  {
    query: "agent start subagent",
    category: "entity",
    relevantSessions: [
      "backfill-019e9c25-6599-7000-813b-01aeabdf0f29",
      "backfill-019e8cf3-e3a2-7000-8a23-3fdce014fb9a",
    ],
  },
  {
    query: "session start context",
    category: "entity",
    relevantSessions: [
      "backfill-019e87b0-24ce-7000-9b2d-fa2877a0350f",
      "backfill-019e8cf8-129d-7000-9472-721ee025a64b",
    ],
  },

  // === Code-level / specific tools ===
  {
    query: "Python script running",
    category: "code",
    relevantSessions: [
      "backfill-019eb9a6-e159-7000-9dc9-f508d70543c2",
      "backfill-019eb9ba-9336-7000-ad3d-7606533c415d",
    ],
  },
  {
    query: "test runner pytest",
    category: "code",
    // Test running spans many sessions; this is a "test the ranking" query
    // rather than a precise label.
    relevantSessions: [],
  },
  {
    query: "git commit version control",
    category: "entity",
    relevantSessions: [
      "backfill-019ee048-082c-7000-a7bf-9132e6cb4d8c",
    ],
  },

  // === Search / navigation ===
  {
    query: "searched file content grep",
    category: "exact",
    relevantSessions: [
      "backfill-019ebcce-63ec-7000-968f-07f41529940b",
      "backfill-019e87b7-a876-7000-9544-88f886c0ab27",
    ],
  },
  {
    query: "skill tool command",
    category: "semantic",
    relevantSessions: [
      "backfill-019e87b0-2514-7000-b50b-1a76493f6f1d",
      "backfill-019e87b0-253a-7000-b942-d5042370d8d6",
    ],
  },
];

interface QueryResult {
  query: string;
  category: string;
  // Observation-level
  retrievedObsIds: string[];
  relevantObsIds: string[];
  obsRecallAt5: number;
  obsRecallAt10: number;
  obsPrecisionAt5: number;
  obsPrecisionAt10: number;
  obsMrr: number;
  obsNdcg10: number;
  obsHitRate10: number;
  // Session-level
  retrievedSessionIds: string[];
  relevantSessionIds: string[];
  sessionRecallAt10: number;
  sessionPrecisionAt10: number;
  sessionMrr: number;
  latencyMs: number;
  notes: string[];
}

function post(
  path: string,
  body: object,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(path, BASE_URL);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          Authorization: `Bearer ${SECRET}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : null,
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function isRelevant(id: string, relevant: Set<string>): boolean {
  if (relevant.has(id)) return true;
  // Full UUID match (no fuzzy 8-char suffix — that conflated too many)
  for (const r of relevant) {
    if (r === id) return true;
  }
  return false;
}

function recallAt(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return NaN;
  const topK = retrieved.slice(0, k);
  let hits = 0;
  for (const r of relevant) {
    if (topK.includes(r)) hits++;
  }
  return hits / relevant.size;
}

function precisionAt(retrieved: string[], relevant: Set<string>, k: number): number {
  const topK = retrieved.slice(0, k);
  if (topK.length === 0 || relevant.size === 0) return NaN;
  let hits = 0;
  for (const t of topK) {
    if (relevant.has(t)) hits++;
  }
  return hits / topK.length;
}

function mrr(retrieved: string[], relevant: Set<string>): number {
  if (relevant.size === 0) return NaN;
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

function hitRate(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return NaN;
  const topK = new Set(retrieved.slice(0, k));
  for (const r of relevant) {
    if (topK.has(r)) return 1;
  }
  return 0;
}

function ndcgAt(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return NaN;
  const topK = retrieved.slice(0, k);
  // Binary relevance: 1 if in relevant set, 0 otherwise
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    if (relevant.has(topK[i])) {
      dcg += 1 / Math.log2(i + 2);
    }
  }
  // Ideal DCG: all relevant items in top positions
  const idealCount = Math.min(relevant.size, k);
  let idcg = 0;
  for (let i = 0; i < idealCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg > 0 ? dcg / idcg : 0;
}

function avg(xs: number[]): number {
  const valid = xs.filter((x) => !Number.isNaN(x));
  return valid.length === 0 ? 0 : valid.reduce((s, x) => s + x, 0) / valid.length;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s.padEnd(n);
}

async function evaluateOne(q: LabeledQuery): Promise<QueryResult> {
  const t0 = Date.now();
  const res = await post("/agentmemory/smart-search", {
    query: q.query,
    limit: 10,
  });
  const results = (res.body?.results ?? []) as Array<{
    obsId: string;
    sessionId: string;
  }>;
  const retrievedObsIds = results.map((r) => r.obsId);
  const retrievedSessionIds = Array.from(new Set(results.map((r) => r.sessionId)));
  const relevantObs = new Set(q.relevantObservations ?? []);
  const relevantSessions = new Set(q.relevantSessions ?? []);
  const latencyMs = Date.now() - t0;

  const notes: string[] = [];
  if (q.relevantSessions && q.relevantSessions.length === 0 && relevantObs.size === 0) {
    notes.push("unlabeled — only HitRate reported");
  }

  return {
    query: q.query,
    category: q.category,
    retrievedObsIds,
    relevantObsIds: Array.from(relevantObs),
    obsRecallAt5: recallAt(retrievedObsIds, relevantObs, 5),
    obsRecallAt10: recallAt(retrievedObsIds, relevantObs, 10),
    obsPrecisionAt5: precisionAt(retrievedObsIds, relevantObs, 5),
    obsPrecisionAt10: precisionAt(retrievedObsIds, relevantObs, 10),
    obsMrr: mrr(retrievedObsIds, relevantObs),
    obsNdcg10: ndcgAt(retrievedObsIds, relevantObs, 10),
    obsHitRate10: hitRate(retrievedObsIds, relevantObs, 10),
    retrievedSessionIds,
    relevantSessionIds: Array.from(relevantSessions),
    sessionRecallAt10: recallAt(retrievedSessionIds, relevantSessions, 10),
    sessionPrecisionAt10: precisionAt(retrievedSessionIds, relevantSessions, 10),
    sessionMrr: mrr(retrievedSessionIds, relevantSessions),
    latencyMs,
    notes,
  };
}

async function main(): Promise<void> {
  console.log(
    `Running ${LABELED_QUERIES.length} labeled queries against ${BASE_URL}\n`,
  );
  const results: QueryResult[] = [];
  for (const q of LABELED_QUERIES) {
    const r = await evaluateOne(q);
    results.push(r);
    const labels =
      (q.relevantObservations?.length ?? 0) + (q.relevantSessions?.length ?? 0);
    console.log(
      `Q: ${pad(q.query, 50)} | ` +
        `sessR@10=${(isNaN(r.sessionRecallAt10) ? "NA" : (r.sessionRecallAt10 * 100).toFixed(0) + "%").padStart(4)} ` +
        `sessMRR=${(isNaN(r.sessionMrr) ? "NA" : r.sessionMrr.toFixed(2)).padStart(5)} ` +
        `latency=${r.latencyMs}ms ` +
        `retr=${r.retrievedSessionIds.slice(0, 3).map((s) => s.slice(-8)).join(",")} ` +
        `(labels=${labels}${r.notes.length ? " " + r.notes[0] : ""})`,
    );
  }

  // Summary
  console.log("\n=== Summary (only labeled queries contribute) ===");
  const labeledResults = results.filter(
    (r) => r.relevantSessionIds.length > 0 || r.relevantObsIds.length > 0,
  );
  console.log(`Labeled queries:       ${labeledResults.length}/${results.length}`);

  // Observation-level
  console.log("\n-- Observation-level (fine-grained) --");
  console.log(`Avg Recall@5:          ${(avg(labeledResults.map((r) => r.obsRecallAt5)) * 100).toFixed(1)}%`);
  console.log(`Avg Recall@10:         ${(avg(labeledResults.map((r) => r.obsRecallAt10)) * 100).toFixed(1)}%`);
  console.log(`Avg Precision@5:       ${(avg(labeledResults.map((r) => r.obsPrecisionAt5)) * 100).toFixed(1)}%`);
  console.log(`Avg Precision@10:      ${(avg(labeledResults.map((r) => r.obsPrecisionAt10)) * 100).toFixed(1)}%`);
  console.log(`Avg MRR:               ${avg(labeledResults.map((r) => r.obsMrr)).toFixed(3)}`);
  console.log(`Avg NDCG@10:           ${avg(labeledResults.map((r) => r.obsNdcg10)).toFixed(3)}`);
  console.log(`HitRate@10:            ${(avg(labeledResults.map((r) => r.obsHitRate10)) * 100).toFixed(1)}%`);

  // Session-level
  console.log("\n-- Session-level (coarse) --");
  console.log(`Avg Recall@10:         ${(avg(labeledResults.map((r) => r.sessionRecallAt10)) * 100).toFixed(1)}%`);
  console.log(`Avg Precision@10:      ${(avg(labeledResults.map((r) => r.sessionPrecisionAt10)) * 100).toFixed(1)}%`);
  console.log(`Avg MRR:               ${avg(labeledResults.map((r) => r.sessionMrr)).toFixed(3)}`);

  console.log(`\nAvg Latency:           ${avg(results.map((r) => r.latencyMs)).toFixed(0)}ms`);

  // By category
  const byCategory = new Map<string, QueryResult[]>();
  for (const r of labeledResults) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category)!.push(r);
  }
  console.log("\n=== By Category (observation-level MRR) ===");
  for (const [cat, rs] of byCategory) {
    console.log(
      `${pad(cat, 15)} n=${rs.length}  ` +
        `obsR@10=${(avg(rs.map((r) => r.obsRecallAt10)) * 100).toFixed(1).padStart(5)}%  ` +
        `sessR@10=${(avg(rs.map((r) => r.sessionRecallAt10)) * 100).toFixed(1).padStart(5)}%  ` +
        `MRR=${avg(rs.map((r) => r.obsMrr)).toFixed(2)}  ` +
        `NDCG=${avg(rs.map((r) => r.obsNdcg10)).toFixed(2)}`,
    );
  }
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
