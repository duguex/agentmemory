// Backfill observations quality eval — measures recall/precision on
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
//      observations (2 VASP sessions), so most queries reported 0%
//      recall for the wrong reason (no labels, not bad search).
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
  // Ground truth refreshed 2026-07-12 against the live corpus.
  // Session labels + observation labels (relevantObservations) for obs-level R@10.
  // Prefer durable backfill-* sessions; auto-* only when needed.

  // === VASP domain ===
  {
    query: "VASP binary file cleanup CHGCAR WAVECAR",
    category: "semantic",
    relevantSessions: [
      "backfill-019ec76e-1b60-7000-a31c-2a631f1b890e",
      "backfill-019ebcce-63ec-7000-968f-07f41529940b",
      "backfill-019ec024-3efe-7000-8bd5-e94cba95eb05",
    ],
    relevantObservations: [
      "obs_mr9pfviu_1e564c9d1a68",
      "obs_mr9pfvl0_d2b86da22ca9",
      "obs_mr9pfwex_81ed7eeee8d5",
      "obs_mr9pfq3y_c5ff865831f3",
    ],
  },
  {
    query: "VASP directory listing exploration",
    category: "semantic",
    relevantSessions: [
      "backfill-019ebb5f-2a16-7000-81bb-6c1addf056a0",
      "backfill-019ec76e-1b60-7000-a31c-2a631f1b890e",
      "backfill-019ec024-3efe-7000-8bd5-e94cba95eb05",
    ],
    relevantObservations: [
      "obs_mr9pfnko_655f4b2942a4",
      "obs_mr9pfu6c_72f7cd46aada",
      "obs_mr9pfwx9_b9d7e2dbc9c4",
      "obs_mr9pfsv5_c8477170dbb5",
    ],
  },
  {
    query: "VASP data analysis Python read script",
    category: "code",
    relevantSessions: [
      "backfill-019f0541-47e6-7000-84f6-c52eecb98bb9",
      "backfill-019ed519-b9f6-7000-9bfc-a5eedb5afedf",
      "backfill-019edb44-916e-7000-b4a0-1a159622c2d7",
    ],
    relevantObservations: [
      "obs_mr9pg16w_9325fce9768b",
      "obs_mr9pg0yq_77d2e717e9c6",
      "obs_mr9pg3js_c42ea13a2b4c",
      "obs_mr9pg3gc_973f156c00d1",
    ],
  },
  {
    query: "directory listing directory survey",
    category: "exact",
    relevantSessions: [
      "backfill-019f03fe-12a1-7000-97a0-f009efe69008",
      "backfill-019ef34d-96c2-7000-8436-5daa5e732596",
      "backfill-019ebfae-7dbc-7000-b928-7422b9066ea6",
    ],
    relevantObservations: [
      "obs_mr9pg5b5_480cdc2293d6",
      "obs_mr9pg40t_9c79c6eac52c",
      "obs_mr9pg49t_7aa8f85a6bb7",
      "obs_mr9pg4gf_8759f7f37552",
    ],
  },

  // === File operations ===
  {
    query: "find large files to delete",
    category: "semantic",
    relevantSessions: [
      "backfill-019edb44-916e-7000-b4a0-1a159622c2d7",
      "backfill-019f03fe-12a1-7000-97a0-f009efe69008",
      "backfill-019ee06c-1bb0-7000-965e-9426d54a5451",
    ],
    relevantObservations: [
      "obs_mr9pg3id_0e834b930d1f",
      "obs_mr9pg3av_d7ca160a9d98",
      "obs_mr9pgbsn_4b9efb8c84b9",
      "obs_mr9pg3ce_35013cf700b4",
    ],
  },
  {
    query: "file read text file",
    category: "exact",
    relevantSessions: [
      "backfill-019ec024-3efe-7000-8bd5-e94cba95eb05",
      "backfill-019ebcce-63ec-7000-968f-07f41529940b",
      "backfill-019ec76e-1b60-7000-a31c-2a631f1b890e",
    ],
    relevantObservations: [
      "obs_mr9pfta6_86574e845a1c",
      "obs_mr9pfv6t_8dcaf40e050c",
      "obs_mr9pfv2e_1b5fa23784e9",
      "obs_mr9pfry8_75791073ddc7",
    ],
  },
  {
    query: "edit YAML configuration file",
    category: "semantic",
    relevantSessions: [
      "auto-mrgnwdpq",
      "auto-mrhjmhbb",
      "auto-mrgtcxxe",
    ],
    relevantObservations: [
      "obs_mrhk4kv1_c25da49a953d",
      "obs_mrgo84wv_9211f6db80a8",
      "obs_mrgtoh20_6a413f0c29a9",
      "obs_mrhk2hmo_586fe02ed625",
    ],
  },

  // === Debugging / error investigation ===
  {
    query: "task error failure investigation",
    category: "semantic",
    relevantSessions: [
      "auto-mrfc4024",
      "auto-mrfcc5lj",
      "auto-mrfds5fx",
      "backfill-019f03fe-12a1-7000-97a0-f009efe69008",
    ],
    relevantObservations: [
      "obs_mrfc42g4_95be5a34ddc2",
      "obs_mrfcc90h_3bdcd77691c7",
      "obs_mrfds91f_b795e3c06507",
      "obs_mrfcccyy_d3b209f79846",
    ],
  },
  {
    query: "PostToolUse hook failure",
    category: "exact",
    relevantSessions: [
      "backfill-019ec024-3efe-7000-8bd5-e94cba95eb05",
      "backfill-019ec76e-1b60-7000-a31c-2a631f1b890e",
      "auto-mrduv00x",
    ],
    relevantObservations: [
      "obs_mr9pfsb5_121ffdc708fb",
      "obs_mr9pfrsq_9bd691dc7721",
      "obs_mr9pfshz_021df7560636",
      "obs_mr9pfubm_9c2ce72a1fdd",
    ],
  },

  // === Agent / session lifecycle ===
  {
    query: "agent start subagent",
    category: "entity",
    relevantSessions: [
      "backfill-019ee06c-1bb0-7000-965e-9426d54a5451",
      "backfill-019ee610-bd2a-7000-84cf-0032885830df",
      "backfill-019ee62c-3a2c-7000-a293-e29f7c44c95d",
    ],
    relevantObservations: [
      "obs_mr9phimc_d4e55075778a",
      "obs_mr9phesc_b810f302b7ea",
      "obs_mr9phf3o_e8e899a87047",
      "obs_mr9phhb8_93e8d5b2721e",
    ],
  },
  {
    query: "session start context",
    category: "entity",
    relevantSessions: [
      "backfill-019ee057-cec3-7000-acdb-5507a28d9afb",
      "backfill-019ebfae-7dbc-7000-b928-7422b9066ea6",
      "backfill-019ee06c-1bb0-7000-965e-9426d54a5451",
    ],
    relevantObservations: [
      "obs_mr9phe8s_e0644832ebfc",
      "obs_mr9phlc8_e781a1b66a70",
      "obs_mr9phee5_4ec25ab133e0",
      "obs_mr9phgmb_453df5637fd3",
    ],
  },

  // === Code-level / specific tools ===
  {
    query: "Python script running",
    category: "code",
    relevantSessions: [
      "backfill-019edb44-916e-7000-b4a0-1a159622c2d7",
      "backfill-019ee62c-3a2c-7000-a293-e29f7c44c95d",
      "backfill-019f03fe-12a1-7000-97a0-f009efe69008",
    ],
    relevantObservations: [
      "obs_mr9phjx9_dc3704696846",
      "obs_mr9pg6s1_49e724ce2b71",
      "obs_mr9phjnu_c1554bcee9f9",
      "obs_mr9pg6uz_a9897bd76e55",
    ],
  },
  {
    query: "test runner pytest",
    category: "code",
    relevantSessions: [
      "backfill-019ee06c-1bb0-7000-965e-9426d54a5451",
      "backfill-019ee62c-3a2c-7000-a293-e29f7c44c95d",
      "auto-mrbr33fp",
    ],
    relevantObservations: [
      "obs_mrbrf0d4_3535803e129c",
      "obs_mr9phjl1_55cbbe2d5c14",
      "obs_mr9phj5r_b26ea019df3d",
      "obs_mr9phfh4_9d600cd59f55",
    ],
  },
  {
    query: "git commit version control",
    category: "entity",
    relevantSessions: [
      "backfill-019ede58-0a57-7000-b373-9a3bbecd911b",
      "backfill-019ec024-3efe-7000-8bd5-e94cba95eb05",
      "backfill-019edb44-916e-7000-b4a0-1a159622c2d7",
    ],
    relevantObservations: [
      "obs_mr9pgmzz_653bef230f2f",
      "obs_mr9pfsdc_e120c57a73be",
      "obs_mr9pg3md_c73ad13fca17",
      "obs_mr9pgn24_0d821d6c7720",
    ],
  },

  // === Search / navigation ===
  {
    query: "searched file content grep",
    category: "exact",
    relevantSessions: [
      "backfill-019ec76e-1b60-7000-a31c-2a631f1b890e",
      "backfill-019ee506-ad10-7000-a303-c0e494b2c910",
      "auto-mraby92r",
    ],
    relevantObservations: [
      "obs_mrabz4s7_678f28f929cc",
      "obs_mr9pfvq7_81ed61994402",
      "obs_mr9pgoqb_d89920e75283",
      "obs_mr9pfu80_ca208f683a26",
    ],
  },
  {
    query: "skill tool command",
    category: "semantic",
    relevantSessions: [
      "backfill-019edb36-a086-7000-b551-335342e2e5c5",
      "backfill-019ee048-082c-7000-a7bf-9132e6cd40df",
      "backfill-019ee06c-1bb0-7000-965e-9426d54a5451",
    ],
    relevantObservations: [
      "obs_mr9phgnz_bb9fd727483f",
      "obs_mr9pgiwj_ba7224d68211",
      "obs_mr9phd6x_7d8b7e57e90c",
      "obs_mr9phf8v_6fb305f3c6e2",
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
