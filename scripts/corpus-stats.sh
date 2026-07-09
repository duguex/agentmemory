#!/bin/bash
# Quick observation stats — what's in agentmemory right now.
# Doesn't hit the /sessions endpoint (which can be slow on 100+ sessions).
# Instead, lists sessions by reading the engine state directly.
#
# Usage: bash scripts/corpus-stats.sh
# (filename kept for backward compat — script actually shows observation stats)

set -e
SECRET="${AGENTMEMORY_SECRET:-omp-memory-local}"
URL="${AGENTMEMORY_URL:-http://localhost:3111}"

echo "═══ Corpus snapshot ═══"
echo "URL: $URL"
echo

# Sessions
echo "── Sessions (top 5 by recent activity) ──"
# Try the sessions endpoint with short timeout
if sessions=$(curl -m 8 -s "$URL/agentmemory/sessions?limit=5" -H "Authorization: Bearer $SECRET" 2>/dev/null); then
    echo "$sessions" | python3 -c "
import sys, json
d = json.load(sys.stdin)
sessions = d.get('sessions', [])
print(f'  total: {len(sessions)} shown (out of all)')
for s in sessions[:5]:
    sid = s.get('id', '?')[:40]
    title = (s.get('summary', {}).get('title') if s.get('summary') else None) or s.get('id', '?')[:30]
    n_obs = s.get('observationCount', '?')
    print(f'  {sid:40s} | {n_obs:>4} obs | {title[:30]}')
" 2>/dev/null || echo "  (parse error)"
else
    echo "  /sessions endpoint timed out (8s). Daemon may be backed up."
    echo "  Try: tail /tmp/daemon-*.log to see what's stuck"
fi
echo

# Observations by kind across all backfill sessions (sampled)
echo "── Observation kinds (sampled, first 5 backfill sessions) ──"
python3 << 'PYEOF'
import json, urllib.request
secret = "omp-memory-local"
url = "http://localhost:3111"
try:
    r = urllib.request.Request(f'{url}/agentmemory/sessions?limit=200', headers={'Authorization': f'Bearer {secret}'})
    sessions = json.loads(urllib.request.urlopen(r, timeout=8).read())['sessions']
except Exception as e:
    print(f"  (skipped — /sessions timed out: {e})")
    raise SystemExit(0)

bf = [s for s in sessions if s['id'].startswith('backfill-')]
llm = syn = unk = 0
sample_sessions = bf[:5]  # sample first 5 to avoid timeout
for s in sample_sessions:
    try:
        r2 = urllib.request.Request(f'{url}/agentmemory/observations?sessionId={s["id"]}', headers={'Authorization': f'Bearer {secret}'})
        obs = json.loads(urllib.request.urlopen(r2, timeout=5).read())['observations']
        for o in obs:
            k = o.get('compressionKind')
            if k == 'llm': llm += 1
            elif k == 'synthetic': syn += 1
            else: unk += 1
    except Exception:
        pass

print(f'  sampled {len(sample_sessions)} of {len(bf)} backfill sessions')
print(f'  LLM-compressed: {llm}')
print(f'  Synthetic:      {syn}')
print(f'  Unknown:        {unk}')
print()
print('  (for full observation stats, see scripts/status.sh)')
PYEOF
echo

# Recent activity
echo "── Recent daemon activity (last 5 log lines) ──"
for f in /tmp/daemon-*.log; do
    if [ -f "$f" ]; then
        # Find most recent
        if [ -z "$LATEST" ] || [ "$f" -nt "$LATEST" ]; then
            LATEST="$f"
        fi
    fi
done
if [ -n "$LATEST" ]; then
    echo "  from $LATEST:"
    tail -5 "$LATEST" | sed 's/^/    /'
fi
