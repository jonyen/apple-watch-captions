#!/bin/bash
# launchd entry point for com.jonyen.caption-transcriber.
set -euo pipefail

APP_DIR="/Users/jonyen/apps/watch-captions-relay"
export PORT="${PORT:-8790}"

exec "$APP_DIR/transcriber/caption-transcriber"
