#!/usr/bin/env bash
# Daily entrypoint invoked by cron at 02:00 UTC (09:00 Asia/Ho_Chi_Minh).
# Syncs code from origin, installs deps if needed, runs the digest pipeline.
set -euo pipefail
cd "$(dirname "$0")"

echo "===== $(date -uIs) syncing from origin/main ====="
# Reset rather than pull so we never get stuck on a merge conflict introduced
# by deploy.yml's rsync (which writes files but doesn't touch .git). If the
# sync fails (network, missing .git), keep going with whatever's on disk —
# the alternative is a missed digest, which is worse than running slightly
# stale code.
if git fetch origin main 2>&1; then
  git reset --hard origin/main 2>&1 || echo "⚠️  git reset failed — continuing with on-disk code"
else
  echo "⚠️  git fetch failed — continuing with on-disk code"
fi

echo "===== $(date -uIs) installing deps ====="
npm ci --omit=dev --no-audit --no-fund

echo "===== $(date -uIs) running bot ====="
exec node index.js run
