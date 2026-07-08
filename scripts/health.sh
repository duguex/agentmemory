#!/bin/bash
# Minimal status — bypasses /sessions endpoint (which can be slow).
# Shows what we can quickly observe.
#
# Usage: bash scripts/health.sh

set -e
SECRET="${AGENTMEMORY_SECRET:-omp-memory-local}"
URL="${AGENTMEMORY_URL:-http://localhost:3111}"
III="${III_BIN:-/home/duguex/.agentmemory/bin/iii}"

echo "═══ Agentmemory quick health ═══"
echo

# 1. Daemon health (fast, <100ms)
echo "── Daemon ──"
HEALTH=$(curl -m 3 -s "$URL/agentmemory/health" -H "Authorization: Bearer $SECRET" 2>/dev/null)
if [ -z "$HEALTH" ]; then
    echo "  ✗ daemon not responding at $URL"
    exit 0
fi
echo "$HEALTH" | python3 -c "
import sys, json
d = json.load(sys.stdin)
h = d['health']
cb = d['circuitBreaker']
icon = '✓' if h['status'] == 'healthy' else '✗'
print(f'  {icon} status: {h[\"status\"]} ({h[\"uptimeSeconds\"]/3600:.1f}h uptime)')
print(f'  circuit: {cb[\"state\"]} (failures={cb[\"failures\"]})')
print(f'  workers: {len(h[\"workers\"])}, event-lag: {h[\"eventLoopLagMs\"]:.2f}ms')
for m in d['functionMetrics']:
    rate = 100 * m['successCount']/m['totalCalls'] if m['totalCalls'] else 0
    color = '✓' if rate >= 80 else '!' if rate >= 50 else '✗'
    print(f'    {color} {m[\"functionId\"]:25s} {m[\"successCount\"]:>5}/{m[\"totalCalls\"]:<5} ({rate:5.1f}%) avgLat={m[\"avgLatencyMs\"]/1000:.1f}s')
"
echo

# 2. Queue stats (fast, <100ms via engine WS)
echo "── Queues ──"
for topic in mem::compress mem::graph-extract; do
    stats=$($III trigger --function-id engine::queue::topic_stats --payload "{\"topic\":\"$topic\"}" 2>/dev/null)
    if [ -n "$stats" ]; then
        echo "$stats" | python3 -c "
import sys, json
d = json.load(sys.stdin)
depth = d.get('depth', 0)
dlq = d.get('dlq_depth', 0)
consumers = d.get('consumer_count', 0)
icon = '✓' if (depth == 0 and dlq == 0) else '!' if (dlq > 0) else '·'
print(f'  {icon} $topic: depth={depth} dlq={dlq} consumers={consumers}')
"
    fi
done
echo

# 3. Ollama
echo "── Ollama ──"
if curl -m 2 -s http://localhost:11434/api/ps > /dev/null 2>&1; then
    curl -s http://localhost:11434/api/ps | python3 -c "
import sys, json
d = json.load(sys.stdin)
for m in d.get('models', []):
    vram = m.get('size_vram', 0) / 1e9
    print(f'  · {m[\"name\"]} ({vram:.1f}GB VRAM)')
"
else
    echo "  ✗ Ollama not responding at localhost:11434"
fi
echo

# 4. Corpus (sampled, not exhaustive)
echo "── Corpus (sampled: 5 backfill sessions) ──"
python3 << 'PYEOF'
import json, urllib.request
secret = "omp-memory-local"
url = "http://localhost:3111"

# Don't go through /sessions endpoint (slow). Hit observation endpoint directly
# for a few known backfill session ids (we have them in the eval benchmark).
known_bf = [
    "backfill-019eb9a6-e159-7000-9dc9-f508d70543c2",
    "backfill-019eb9b4-cbcf-7000-96ab-7bcc666ef668",
    "backfill-019eb9d6-f241-7000-a973-5d6bb6792882",
    "backfill-019e9c60-319a-7000-beae-18fd40bd11c5",
    "backfill-019e87b0-24ce-7000-9b2d-fa2877a0350f",
]
llm = syn = unk = 0
for sid in known_bf:
    try:
        r = urllib.request.Request(f'{url}/agentmemory/observations?sessionId={sid}', headers={'Authorization': f'Bearer {secret}'})
        obs = json.loads(urllib.request.urlopen(r, timeout=3).read())['observations']
        for o in obs:
            k = o.get('compressionKind')
            if k == 'llm': llm += 1
            elif k == 'synthetic': syn += 1
            else: unk += 1
    except Exception as e:
        print(f'  (skipped {sid[:20]}: {e})')
        break

print(f'  sampled: LLM={llm} synthetic={syn} unknown={unk}')
PYEOF
echo

# 5. Recent log
echo "── Recent daemon activity ──"
LATEST=""
for f in /tmp/daemon-*.log; do
    if [ -f "$f" ] && [ -z "$LATEST" -o "$f" -nt "$LATEST" ]; then
        LATEST="$f"
    fi
done
if [ -n "$LATEST" ]; then
    echo "  from $LATEST:"
    tail -5 "$LATEST" | grep -vE '^│|^├|^◇|^●|^$' | sed 's/^/    /'
fi
