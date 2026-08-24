#!/bin/bash
# Downloads the compiled Moonshine Core ML models the "On device" session
# uses, from a moonshine-coreml release, into watch/Models/Moonshine/.
# Run before `xcodegen generate`. Usage: watch/Scripts/fetch-moonshine.sh [0.2.0] [base|tiny]
set -euo pipefail
VERSION="${1:-0.2.0}"
MODEL="${2:-base}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/Models/Moonshine"
URL="https://github.com/jonyen/moonshine-coreml/releases/download/v$VERSION/moonshine-$MODEL-coreml-v$VERSION.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fL "$URL" -o "$TMP/models.zip"
rm -rf "$DEST" && mkdir -p "$DEST"
unzip -oq "$TMP/models.zip" -d "$DEST"
echo "Moonshine $MODEL v$VERSION in $DEST:"; ls "$DEST"
