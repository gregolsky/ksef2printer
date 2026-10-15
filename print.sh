#!/bin/sh
# Runs ksef2printer in Docker. Examples:
#   ./print.sh setup        find your printer and save its settings
#   ./print.sh test-page    print a test page
#   ./print.sh print-pdf data/some.pdf
set -eu
cd "$(dirname "$0")"
mkdir -p data config
exec docker compose run --rm ksef2printer "$@"
