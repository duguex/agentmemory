// Backfill corpus quality eval — measures recall/precision on
// actual agentmemory data (2757 LLM-compressed backfill obs)
// against hand-labeled queries.

import http from "node:http";

const SECRET = process.env.AGENTMEMORY_SECRET ?? "omp-memory-local";
const BASE_URL = process.env.AGENTMEMORY_URL ?? "http://localhost:3111";

interface LabeledQuery {
  query: string;
  category: "exact" | "semantic" | "entity" | "cross-session";
  relevantSessions: string[];
}

const LABELED_QUERIES: LabeledQuery[] = [
  // Query 1: Semantic — VASP workspace exploration
  // Multiple sessions are about exploring VASP directory structure
  {
    query: "VASP directory listing exploration",
    category: "semantic",
    relevantSessions: [
      "backfill-019eb9a6-e159-7000-9dc9-f508d70543c2", // ZFS directory survey
      "backfill-019eb9ba-9336-7000-ad3d-7606533c415d", // DV directory exploration
    ],
  },
  // Query 2: Semantic — VASP binary file cleanup (a specific workflow)
  {
    query: "VASP binary file cleanup CHGCAR WAVECAR",
    category: "semantic",
    relevantSessions: [
      "backfill-019eb9b4-cbcf-7000-96ab-7bcc666ef668", // 7-task cleanup workflow
    ],
  },
  // Query 3: Semantic — VASP data analysis (Python scripting)
  {
    query: "VASP data analysis Python read script",
    category: "semantic",
    relevantSessions: [
      "backfill-019eb9a6-e159-7000-9dc9-f508d70543c2", // fit_parameter script reading
      "backfill-019eb9ba-9336-7000-ad3d-7606533c415d", // DV_hh_zfs_data reading
    ],
  },
  // Query 4: Exact — specific tool action phrase
  {
    query: "directory listing directory survey",
    category: "exact",
    relevantSessions: [
      "backfill-019eb9a6-e159-7000-9dc9-f508d70543c2",
      "backfill-019eb9ba-9336-7000-ad3d-7606533c415d",
    ],
  },
  // Query 5: Cross-session — should return many backfill sessions
  {
    query: "VASP",
    category: "cross-session",
    relevantSessions: [],
  },
  // Query 6: Entity — file path keyword
  {
    query: "Python script",
    category: "entity",
    relevantSessions: [
      "backfill-019eb9a6-e159-7000-9dc9-f508d70543c2", // fit_parameter_vs_avg_zfs.py
      "backfill-019eb9ba-9336-7000-ad3d-7606533c415d", // python scripts in DV
    ],
  },
];

interface QueryResult {
  query: string;
  category: string;
  retrievedSessionIds: string[];
  relevantSessionIds: string[];
  recallAt5: number;
  recallAt10: number;
  precisionAt5: number;
  precisionAt10: number;
  mrr: number;
  latencyMs: number;
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

// Match ground-truth full UUID vs smart-search truncated ID via 8-char suffix.
function idMatches(a: string, b: string): boolean {
  if (a === b) return true;
  const min = Math.min(a.length, b.length, 8);
  return a.slice(-min) === b.slice(-min);
}

function recall(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 1;
  const topK = retrieved.slice(0, k);
  let hits = 0;
  for (const id of relevant) {
    if (topK.some((t) => idMatches(t, id))) hits++;
  }
  return hits / relevant.size;
}

function precision(retrieved: string[], relevant: Set<string>, k: number): number {
  const topK = retrieved.slice(0, k);
  if (topK.length === 0 || relevant.size === 0) return 0;
  let hits = 0;
  for (const id of topK) {
    if (Array.from(relevant).some((r) => idMatches(id, r))) hits++;
  }
  return hits / topK.length;
}

function mrr(retrieved: string[], relevant: Set<string>): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (Array.from(relevant).some((r) => idMatches(retrieved[i], r))) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

async function evaluateOne(q: LabeledQuery): Promise<QueryResult> {
  const t0 = Date.now();
  const res = await post("/agentmemory/smart-search", {
    query: q.query,
    limit: 10,
  });
  const results = (res.body?.results ?? []) as Array<{ sessionId: string }>;
  const retrieved = Array.from(new Set(results.map((r) => r.sessionId)));
  const relevant = new Set(q.relevantSessions);
  const latencyMs = Date.now() - t0;
  return {
    query: q.query,
    category: q.category,
    retrievedSessionIds: retrieved,
    relevantSessionIds: Array.from(relevant),
    recallAt5: recall(retrieved, relevant, 5),
    recallAt10: recall(retrieved, relevant, 10),
    precisionAt5: precision(retrieved, relevant, 5),
    precisionAt10: precision(retrieved, relevant, 10),
    mrr: mrr(retrieved, relevant),
    latencyMs,
  };
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s.padEnd(n);
}

async function main(): Promise<void> {
  console.log(
    `Running ${LABELED_QUERIES.length} labeled queries against ${BASE_URL}\n`,
  );
  const results: QueryResult[] = [];
  for (const q of LABELED_QUERIES) {
    const r = await evaluateOne(q);
    results.push(r);
    console.log(
      `Q: ${pad(q.query, 50)} | ` +
        `R@10=${(r.recallAt10 * 100).toFixed(0).padStart(3)}% ` +
        `P@5=${(r.precisionAt5 * 100).toFixed(0).padStart(3)}% ` +
        `MRR=${r.mrr.toFixed(2)} ` +
        `latency=${r.latencyMs}ms ` +
        `retr=${r.retrievedSessionIds.slice(0, 3).map((s) => s.slice(-12)).join(",")}`,
    );
  }

  console.log("\n=== Summary ===");
  console.log(`Queries:               ${results.length}`);
  console.log(`Avg Recall@5:          ${(avg(results.map((r) => r.recallAt5)) * 100).toFixed(1)}%`);
  console.log(`Avg Recall@10:         ${(avg(results.map((r) => r.recallAt10)) * 100).toFixed(1)}%`);
  console.log(`Avg Precision@5:       ${(avg(results.map((r) => r.precisionAt5)) * 100).toFixed(1)}%`);
  console.log(`Avg Precision@10:      ${(avg(results.map((r) => r.precisionAt10)) * 100).toFixed(1)}%`);
  console.log(`Avg MRR:               ${avg(results.map((r) => r.mrr)).toFixed(3)}`);
  console.log(`Avg Latency:           ${avg(results.map((r) => r.latencyMs)).toFixed(0)}ms`);

  const byCategory = new Map<string, QueryResult[]>();
  for (const r of results) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category)!.push(r);
  }
  console.log("\n=== By Category ===");
  for (const [cat, rs] of byCategory) {
    console.log(
      `${pad(cat, 15)} n=${rs.length}  R@10=${(avg(rs.map((r) => r.recallAt10)) * 100).toFixed(1)}%  MRR=${avg(rs.map((r) => r.mrr)).toFixed(2)}`,
    );
  }
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
