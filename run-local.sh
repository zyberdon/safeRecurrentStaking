#!/usr/bin/env bash
#
# Local production-style runner for the Safenet Aegis rewards sweep.
#
# Mimics the GitHub Actions schedule (hourly) with DRY_RUN=false, running
# until you press Ctrl+C. Uses the same .env file as the app.
#
# Usage:
#   ./run-local.sh            # hourly loop, DRY_RUN=false (production)
#   ./run-local.sh --dry-run  # hourly loop, DRY_RUN=true (safe)
#   ./run-local.sh --once     # run a single sweep and exit
#   ./run-local.sh --interval 300   # custom interval in seconds (default 3600)
#
# Requires: node >= 20, npm deps installed, dist/ built (npm run build).

set -euo pipefail

cd "$(dirname "$0")"

INTERVAL=3600
DRY_RUN_VALUE="false"
ONCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN_VALUE="true"; shift ;;
    --once) ONCE=true; shift ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# The app loads .env itself via dotenv/config (handles JSON values correctly).
# We only override DRY_RUN here; do NOT source .env (shell sourcing strips
# quotes from JSON values like CLIENT_SAFES_JSON).
export DRY_RUN="${DRY_RUN:-$DRY_RUN_VALUE}"

if [[ ! -f dist/index.js ]]; then
  echo "dist/ not built — running npm run build first..."
  npm run build
fi

echo "=============================================================="
echo " Safenet Aegis local runner"
echo "   DRY_RUN:      $DRY_RUN"
echo "   interval:     ${INTERVAL}s"
echo "   mode:         $([ "$ONCE" = true ] && echo 'single run' || echo 'hourly loop (Ctrl+C to stop)')"
echo "   started:      $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "=============================================================="

run_sweep() {
  echo ""
  echo ">>> Sweep started: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  node dist/index.js
  echo ">>> Sweep finished: $(date -u '+%Y-%m-%d %H:%M:%S UTC') (exit $?)"
}

run_sweep

if [[ "$ONCE" = true ]]; then
  echo "Single run complete."
  exit 0
fi

while true; do
  echo ""
  echo ">>> Next sweep in ${INTERVAL}s (Ctrl+C to stop)..."
  sleep "$INTERVAL"
  run_sweep
done
