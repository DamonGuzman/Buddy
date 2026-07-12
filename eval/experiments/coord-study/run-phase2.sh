#!/bin/sh
# run-phase2.sh — after phase 1 (all 7 conditions on full): transfer + sanity
# + real-screenshot runs. Args: $1 $2 = the two most promising conditions
# (default grid-100 baseline-plain), $3 = best image variant for the real
# screenshot intervention run (default grid-100).
cd "$(dirname "$0")"
C1=${1:-grid-100}
C2=${2:-baseline-plain}
BEST=${3:-grid-100}

echo "=== mini transfer: $C1 + $C2 ==="
node harness.mjs --condition "$C1" --model gpt-realtime-2.1-mini --layouts A,B || echo "mini $C1 FAILED"
node harness.mjs --condition "$C2" --model gpt-realtime-2.1-mini --layouts A,B || echo "mini $C2 FAILED"

echo "=== REST sanity (non-realtime vision model) ==="
node rest-sanity.mjs --model gpt-5.2 || echo "rest sanity FAILED"

echo "=== real screenshot: production framing + best intervention ==="
node harness.mjs --condition baseline-anchors --model gpt-realtime-2.1 \
  --image images/real-plain.jpg --targets real-targets.json || echo "real anchors FAILED"
node harness.mjs --condition "$BEST" --model gpt-realtime-2.1 \
  --image "images/real-$(echo "$BEST" | sed 's/grid-100/grid100/; s/ruler-edge/ruler/; s/baseline-.*/plain/; s/normalized/plain/; s/think-first/plain/')".jpg \
  --targets real-targets.json || echo "real best FAILED"

echo "=== phase 2 done ==="
