#!/usr/bin/env bash
# Runs the four suites with the JavaScript clock moved forward and/or under another time zone.
#   db/test-support/clock-check.sh [days] [time-zone] [package...]
# Examples:
#   db/test-support/clock-check.sh 30
#   db/test-support/clock-check.sh 400 Pacific/Kiritimati
#   db/test-support/clock-check.sh 0 Pacific/Pago_Pago ingest
# Needs TEST_DATABASE_ADMIN_URL for the database tests (throwaway mcp_test_* databases only).
# Postgres now() is not moved; see shifted-clock.ts.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
days="${1:-0}"
zone="${2:-UTC}"
shift $(( $# > 2 ? 2 : $# ))
pkgs=("$@")
[ ${#pkgs[@]} -eq 0 ] && pkgs=(db pipeline api ingest)
status=0
for p in "${pkgs[@]}"; do
  echo "== $p (clock +${days} days, TZ=${zone})"
  (cd "$root/$p" && CLOCK_OFFSET_DAYS="$days" TZ="$zone" \
    pnpm exec vitest run --maxWorkers=2 --config "$root/db/test-support/vitest.clock.config.ts") || status=1
done
exit $status
