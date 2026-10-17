#!/bin/sh
# Runs ksef2printer in Docker. Examples:
#   ./print.sh setup        find your printer and save its settings
#   ./print.sh test-page    print a test page
#   ./print.sh 2026-09 --dry-run
set -eu
cd "$(dirname "$0")"
mkdir -p data config
# When the ntfy listener is running, use its container: a second container would start a second
# CUPS on the same host port.
if [ -n "$(docker compose ps -q --status running listener 2>/dev/null)" ]; then
  exec docker compose exec listener ksef2printer "$@"
fi
exec docker compose run --rm ksef2printer "$@"
