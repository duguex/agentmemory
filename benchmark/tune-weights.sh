#!/bin/bash
# Tune hybrid search weights via grid search.
# Phase 2.4 of the agentmemory improvement plan.
#
# For each (BM25, vector, graph) triple:
#   1. Stop daemon
#   2. Start with new env vars
#   3. Wait for daemon to register
#   4. Run benchmark/backfill-quality-eval.ts
#   5. Record results
#   6. Move to next triple
#
# Total time: 16 (current run + restart) × ~30s = 8 minutes
# for a 5×5×2 grid (50 combos), or 2 minutes for a 5×5 grid (no graph sweep).

set -e
cd /home/duguex/memory/agentmemory

WORKER_PID_FILE="/home/duguex/.agentmemory/worker.pid"
RESULTS="/tmp/weight-tune-results.csv"
echo "bm25,vector,graph,R@10,P@10,MRR,latency_ms" > "$RESULTS"

# Quick 3x3 grid (skip exhaustive 5x5 to keep runtime bounded)
for BM25 in 0.3 0.5 0.7; do
  for VECTOR in 0.3 0.5 0.7; do
    GRAPH=0.3
    echo
    echo "=== bm25=$BM25 vector=$VECTOR graph=$GRAPH ==="
    # Stop existing daemon
    if [ -f "$WORKER_PID_FILE" ]; then
      OLDPID=$(cat "$WORKER_PID_FILE" 2>/dev/null)
      [ -n "$OLDPID" ] && kill -9 "$OLDPID" 2>/dev/null || true
    fi
    # Also stop any stray agentmemory processes
    pkill -9 -f "node.*agentmemory" 2>/dev/null || true
    sleep 5
    # Start with new weights
    BM25_WEIGHT=$BM25 VECTOR_WEIGHT=$VECTOR AGENTMEMORY_GRAPH_WEIGHT=$GRAPH \
      nohup agentmemory > /tmp/daemon-tune.log 2>&1 &
    # Wait for daemon to be ready
    for i in {1..30}; do
      sleep 1
      HTTP=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3111/agentmemory/health" -H "Authorization: Bearer omp-memory-local" 2>/dev/null || echo "000")
      if [ "$HTTP" = "200" ]; then
        break
      fi
    done
    if [ "$HTTP" != "200" ]; then
      echo "  daemon failed to start, skipping"
      echo "$BM25,$VECTOR,$GRAPH,SKIP,SKIP,SKIP,SKIP" >> "$RESULTS"
      continue
    fi
    # Run eval
    OUTPUT=$(npx tsx benchmark/backfill-quality-eval.ts 2>&1)
    R10=$(echo "$OUTPUT" | grep "Avg Recall@10:" | tail -1 | awk '{print $NF}' | tr -d '%')
    P10=$(echo "$OUTPUT" | grep "Avg Precision@10:" | awk '{print $NF}' | tr -d '%')
    MRR=$(echo "$OUTPUT" | grep "Avg MRR:" | head -1 | awk '{print $NF}')
    LAT=$(echo "$OUTPUT" | grep "Avg Latency:" | awk '{print $NF}' | tr -d 'm')
    echo "  R@10=$R10 P@10=$P10 MRR=$MRR lat=$LAT"
    echo "$BM25,$VECTOR,$GRAPH,$R10,$P10,$MRR,$LAT" >> "$RESULTS"
  done
done

echo
echo "=== Results (sorted by R@10 desc) ==="
echo "bm25,vector,graph,R@10,P@10,MRR,latency_ms"
sort -t, -k4 -nr "$RESULTS" | head -10
