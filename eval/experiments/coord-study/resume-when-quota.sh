#!/bin/sh
# resume-when-quota.sh — poll quota every 3 min (max 60 min); when it returns,
# run the remaining full-model conditions.
cd "$(dirname "$0")"
i=0
while [ $i -lt 20 ]; do
  if node probe-quota.mjs; then
    echo "=== quota restored, resuming remaining conditions ==="
    for c in ruler-edge fiducials normalized think-first; do
      node harness.mjs --condition $c --model gpt-realtime-2.1 --layouts A,B || echo "CONDITION $c FAILED"
    done
    echo "=== phase 1 done ==="
    exit 0
  fi
  i=$((i+1))
  sleep 180
done
echo "=== gave up after 60 min, quota still exhausted ==="
exit 1
