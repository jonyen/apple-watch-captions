#!/bin/bash
# Downloads the compiled Moonshine Tiny Core ML models the "On device" session
# uses, from a moonshine-coreml release, into watch/Models/MoonshineTiny/.
# Run before `xcodegen generate`. Usage: watch/Scripts/fetch-moonshine.sh [0.1.0]
set -euo pipefail
VERSION="${1:-0.1.0}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/Models/MoonshineTiny"
URL="https://github.com/jonyen/moonshine-coreml/releases/download/v$VERSION/moonshine-tiny-coreml-v$VERSION.zip"
TMP="$(mktemp -d)"
curl -fL "$URL" -o "$TMP/models.zip"
rm -rf "$DEST" && mkdir -p "$DEST"
unzip -oq "$TMP/models.zip" -d "$DEST"
rm -rf "$TMP"
echo "Moonshine Tiny v$VERSION in $DEST:"; ls "$DEST"
