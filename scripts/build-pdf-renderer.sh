#!/bin/sh
# Builds CIRFMF/ksef-pdf-generator (MIT) at a pinned commit into vendor/ksef-pdf.js for local
# development. The Docker image does the same in its pdf-renderer stage.
set -eu
COMMIT="${KSEF_PDF_GENERATOR_COMMIT:-8a18843db12d0013a417500bb2f98bfe49b7d2a8}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -fsSL "https://github.com/CIRFMF/ksef-pdf-generator/archive/$COMMIT.tar.gz" | tar xz -C "$WORK" --strip-components=1
cd "$WORK"
npm ci --ignore-scripts --no-audit --no-fund
npx vite build --mode production
mkdir -p "$ROOT/vendor"
cp dist/ksef-fe-invoice-converter.js "$ROOT/vendor/ksef-pdf.js"
cp LICENSE "$ROOT/vendor/ksef-pdf.LICENSE"
echo "built vendor/ksef-pdf.js from ksef-pdf-generator@$COMMIT"
