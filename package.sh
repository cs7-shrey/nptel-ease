#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="$ROOT_DIR/../nptel-ease.zip"

cd "$ROOT_DIR"
rm -f "$OUTPUT"

zip "$OUTPUT" \
  manifest.json \
  background.js \
  popup.html \
  popup.css \
  popup.js \
  assets/icon-16.png \
  assets/icon-32.png \
  assets/icon-48.png \
  assets/icon-128.png

echo
echo "Created: $OUTPUT"
unzip -Z1 "$OUTPUT"
