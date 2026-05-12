#!/usr/bin/env bash
# Daily entrypoint invoked by cron at 02:00 UTC (09:00 Asia/Ho_Chi_Minh).
# Pulls latest main, installs deps if needed, runs the digest pipeline.
set -euo pipefail
cd "$(dirname "$0")"

echo "===== $(date -uIs) pulling latest ====="
git pull --ff-only origin main

echo "===== $(date -uIs) installing deps ====="
npm ci --omit=dev --no-audit --no-fund

echo "===== $(date -uIs) running bot ====="
exec node index.js run
