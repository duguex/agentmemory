#!/bin/bash
# Trace a specific observation through the agentmemory pipeline.
# Shows: does it exist? what state? has compress been attempted? DLQ?
#
# Usage: bash scripts/trace-obs.sh <sessionId> <observationId>

set -e
SECRET="${AGENTMEMORY_SECRET:-omp-memory-local}"
URL="${AGENTMEMORY_URL:-http://localhost:3111}"
III="${III_BIN:-/home/duguex/.agentmemory/bin/iii}"

SESSION="${1:-auto-mralcwyu}"
OBS="${2:-}"

if [ -z "$OBS" ]; then
    echo "Usage: $0 <sessionId> <observationId>"
    echo
    echo "Recent observations in $SESSION:"
    curl -m 5 -s "$URL/agentmemory/observations?sessionId=$SESSION" -H "Authorization: Bearer $SECRET" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for o in d.get('observations', [])[:5]:
        print(f'  {o[\"id\"]}  kind={o.get(\"compressionKind\")}')
except: pass
"
    exit 0
fi

echo "═══ Trace: $SESSION / $OBS ═══"
echo

# 1. KV state
echo "── KV state ──"
curl -m 3 -s "$URL/agentmemory/observations?sessionId=$SESSION" -H "Authorization: Bearer $SECRET" | python3 -c "
import sys, json
target = '$OBS'
try:
    d = json.load(sys.stdin)
    obs_list = d.get('observations', [])
    found = [o for o in obs_list if o.get('id') == target]
    if not found:
        print(f'  ✗ obs not found in {len(obs_list)} observations of $SESSION')
    else:
        o = found[0]
        kind = o.get('compressionKind')
        icon = '✓' if kind == 'llm' else '!' if kind == 'synthetic' else '·'
        print(f'  {icon} compressionKind: {kind}')
        print(f'  importance: {o.get(\"importance\")}')
        print(f'  type: {o.get(\"type\")}')
        title = o.get('title') or '(no title)'
        print(f'  title: {title[:80]}')
        concepts = o.get('concepts') or []
        print(f'  concepts ({len(concepts)}): {concepts[:5]}')
        narrative = o.get('narrative') or ''
        print(f'  narrative: {narrative[:100]}{\"...\" if len(narrative) > 100 else \"\"}')
        ts = o.get('timestamp') or o.get('createdAt') or '?'
        print(f'  timestamp: {ts}')
except Exception as e:
    print(f'  ERROR: {e}')
"
echo

# 2. Queue state
echo "── Queue state (related to compress) ──"
$III trigger --function-id engine::queue::topic_stats --payload '{"topic":"mem::compress"}' 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'  depth: {d[\"depth\"]} (enqueued, waiting)')
print(f'  dlq:   {d[\"dlq_depth\"]} (failed 3+ times)')
print(f'  consumers: {d[\"consumer_count\"]}')
"
echo

# 3. Search for the obs in DLQ
echo "── Is this obs in the DLQ? ──"
python3 << PYEOF
import json, subprocess
target = "$OBS"
r = subprocess.run(
    ["$III", "trigger", "--function-id", "engine::queue::dlq_messages",
     "--payload", json.dumps({"topic": "mem::compress", "limit": 5000})],
    capture_output=True, text=True
)
try:
    dlq = json.loads(r.stdout)
    matches = [m for m in dlq if m.get('payload', {}).get('observationId') == target]
    if matches:
        for m in matches[:3]:
            err = m.get('error', '?')
            retries = m.get('retries', '?')
            mid = m.get('id', '?')[:20]
            print(f'  ! in DLQ: id={mid} retries={retries} error={err}')
    else:
        print(f'  · not in DLQ (sampled {len(dlq)} messages)')
except Exception as e:
    print(f'  ERROR: {e}')
PYEOF
echo

# 4. Search index hit test
echo "── Does smart-search find this obs? ──"
# Try a query that would match this obs's title
curl -m 3 -s "$URL/agentmemory/observations?sessionId=$SESSION" -H "Authorization: Bearer $SECRET" | python3 -c "
import sys, json, urllib.request
target_obs = '$OBS'
d = json.load(sys.stdin)
match = [o for o in d.get('observations', []) if o.get('id') == target_obs]
if not match:
    print('  (skipped: obs not in KV)')
    raise SystemExit(0)
title_words = (match[0].get('title') or '').split()[:3]
if not title_words:
    print('  (skipped: no title)')
    raise SystemExit(0)
query = ' '.join(title_words)
print(f'  testing query: \"{query}\"')
r = urllib.request.Request('http://localhost:3111/agentmemory/smart-search',
    headers={'Authorization': 'Bearer omp-memory-local', 'Content-Type': 'application/json'},
    data=json.dumps({'query': query, 'limit': 10}).encode())
try:
    import urllib.error
    res = urllib.request.urlopen(r, timeout=5)
    hits = json.loads(res.read()).get('results', [])
    found_in = [i+1 for i, h in enumerate(hits) if h.get('obsId') == target_obs]
    if found_in:
        print(f'  ✓ found at position(s) {found_in} of {len(hits)}')
    else:
        print(f'  ✗ NOT in top {len(hits)} hits for query \"{query}\"')
except urllib.error.URLError as e:
    print(f'  (skipped: smart-search timed out: {e})')
except Exception as e:
    print(f'  ERROR: {e}')
"
echo

# 5. Recent log activity
echo "── Recent log activity for this obs ──"
LATEST=""
for f in /tmp/daemon-*.log; do
    if [ -f "$f" ] && [ -z "$LATEST" -o "$f" -nt "$LATEST" ]; then
        LATEST="$f"
    fi
done
if [ -n "$LATEST" ]; then
    if grep -q "$OBS" "$LATEST" 2>/dev/null; then
        grep "$OBS" "$LATEST" | tail -5 | sed 's/^/  /'
    else
        echo "  (no log entries mention this obs id)"
    fi
fi
