#!/usr/bin/env bash
# Push SiliconFlow AI vars to the Railway API service.
# Requires: railway CLI logged in, or RAILWAY_TOKEN in the environment.
# Usage (from repo root):
#   export SILICONFLOW_API_KEY='sk-...'
#   ./scripts/setup-siliconflow-railway.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="${SILICONFLOW_API_KEY:-}"
if [[ -z "$KEY" ]]; then
  if [[ -f "$ROOT/services/api/.env" ]]; then
    KEY="$(grep -E '^SILICONFLOW_API_KEY=' "$ROOT/services/api/.env" | head -1 | cut -d= -f2-)"
  fi
fi
if [[ -z "$KEY" ]]; then
  echo "Set SILICONFLOW_API_KEY first (or put it in services/api/.env)." >&2
  exit 1
fi

if ! command -v railway >/dev/null 2>&1; then
  echo "Railway CLI not found. Install from https://docs.railway.com/guides/cli" >&2
  exit 1
fi

MODEL="${AI_MODEL:-Qwen/Qwen2.5-7B-Instruct}"
BASE="${AI_BASE_URL:-https://api.siliconflow.com/v1}"

echo "Setting AI variables on linked Railway service…"
railway variables set \
  "SILICONFLOW_API_KEY=${KEY}" \
  "AI_MODEL=${MODEL}" \
  "AI_BASE_URL=${BASE}" \
  "AI_DAILY_REQUEST_LIMIT=50" \
  "AI_MOD_CHECK_DAILY_LIMIT=50" \
  "AI_COMMUNITY_DAILY_LIMIT=50" \
  "AI_HOME_DAILY_LIMIT=50"

echo "Done. Redeploy the API service if Railway did not auto-redeploy."
echo "Verify with a signed-in Studio autocomplete or Health AI mod check."
