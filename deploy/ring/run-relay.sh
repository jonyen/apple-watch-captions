#!/bin/bash
# launchd entry point for com.jonyen.caption-relay.
# Sources the secrets env file (not in git; lives only on ring, mode 600),
# then execs the relay via tsx exactly like `npm start` does.
set -euo pipefail

APP_DIR="/Users/jonyen/apps/watch-captions-relay"
ENV_FILE="$APP_DIR/env"

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
else
  echo "FATAL: $ENV_FILE not found" >&2
  exit 1
fi

cd "$APP_DIR/backend"
exec node_modules/.bin/tsx src/index.ts
