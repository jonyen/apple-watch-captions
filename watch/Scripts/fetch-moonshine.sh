#!/bin/bash
# Downloads the compiled on-device model the "On device" session uses, from a
# moonshine-coreml release, into watch/Models/Parakeet/. The Parakeet zip ships
# an fp16 build at its root and an int8/ variant; the watch bundles int8.
# Run before `xcodegen generate`. Usage: watch/Scripts/fetch-moonshine.sh [0.3.0]
set -euo pipefail
VERSION="${1:-0.3.0}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/Models/Parakeet"
URL="https://github.com/jonyen/moonshine-coreml/releases/download/v$VERSION/parakeet-ctc-110m-coreml-v$VERSION.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fL "$URL" -o "$TMP/models.zip"
unzip -oq "$TMP/models.zip" -d "$TMP/unpacked"
rm -rf "$DEST" && mkdir -p "$DEST"
cp -R "$TMP/unpacked/int8/." "$DEST/"
echo "Parakeet CTC 110M (int8) v$VERSION in $DEST:"; ls "$DEST"
