#!/bin/bash
# Sync the relay backend + the release-built transcriber sidecar binary to
# ring, install dependencies there, and (re)apply codesigning to the copied
# binary so Gatekeeper doesn't block a headless launchd launch.
#
# Run this FROM the build Mac (this repo checkout). It does NOT touch
# secrets, launchd, or anything belonging to doorlog/tailscale on ring.
#
# Usage: deploy/ring/sync.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RING_HOST="ring"
RING_APP_DIR="/Users/jonyen/apps/watch-captions-relay"

echo "==> Building transcriber-mac release binary (local, arm64)"
(cd "$REPO_ROOT/transcriber-mac" && swift build -c release)

BIN="$REPO_ROOT/transcriber-mac/.build/release/caption-transcriber"
if [ ! -x "$BIN" ]; then
  echo "ERROR: $BIN not found or not executable" >&2
  exit 1
fi

echo "==> Ensuring ring app directories exist"
ssh "$RING_HOST" "mkdir -p '$RING_APP_DIR/backend' '$RING_APP_DIR/transcriber' '$RING_APP_DIR/data/transcripts' '$RING_APP_DIR/logs'"

echo "==> rsyncing backend/ (excluding node_modules, dist, .env)"
rsync -az --delete \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.env' \
  --exclude '.git' \
  "$REPO_ROOT/backend/" "$RING_HOST:$RING_APP_DIR/backend/"

echo "==> Copying transcriber binary"
scp "$BIN" "$RING_HOST:$RING_APP_DIR/transcriber/caption-transcriber"
ssh "$RING_HOST" "chmod +x '$RING_APP_DIR/transcriber/caption-transcriber'"

echo "==> npm ci --omit=dev on ring"
ssh "$RING_HOST" "export PATH=/opt/homebrew/bin:/opt/homebrew/sbin:\$PATH; cd '$RING_APP_DIR/backend' && npm ci --omit=dev"

echo "==> Re-signing the copied binary (adhoc) so headless launchd will run it"
ssh "$RING_HOST" "codesign -s - --force '$RING_APP_DIR/transcriber/caption-transcriber'"

echo "==> Copying wrapper scripts"
scp "$REPO_ROOT/deploy/ring/run-relay.sh" "$REPO_ROOT/deploy/ring/run-transcriber.sh" "$RING_HOST:$RING_APP_DIR/"
ssh "$RING_HOST" "chmod +x '$RING_APP_DIR/run-relay.sh' '$RING_APP_DIR/run-transcriber.sh'"

echo "==> Done. Secrets env file and launchd plists are handled separately —"
echo "    see deploy/ring/README.md."
