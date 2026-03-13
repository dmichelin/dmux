#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_PATH="$ROOT_DIR/dist/mac-arm64/dmux.app"
LINK_PATH="/Applications/dmux.app"

cd "$ROOT_DIR"

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Building dmux.app..."
npm run pack

if [[ ! -d "$APP_PATH" ]]; then
  echo "Expected app bundle not found at $APP_PATH" >&2
  exit 1
fi

echo "Linking $LINK_PATH -> $APP_PATH"
ln -sfn "$APP_PATH" "$LINK_PATH"

echo
echo "dmux is ready."
echo "Launch it from /Applications/dmux.app"
