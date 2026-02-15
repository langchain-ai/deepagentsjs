#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
RUST_DIR="$PACKAGE_DIR/rust"
ASSETS_DIR="$PACKAGE_DIR/assets"

# Ensure output directory exists
mkdir -p "$ASSETS_DIR"

# Ensure wasm-pack is installed
if ! command -v wasm-pack &>/dev/null; then
  echo "Error: wasm-pack is not installed. Install it with: cargo install wasm-pack" >&2
  exit 1
fi

# Ensure wasm32 target is available
if ! rustup target list --installed | grep -q wasm32-unknown-unknown; then
  echo "Adding wasm32-unknown-unknown target..."
  rustup target add wasm32-unknown-unknown
fi

echo "Building deepbash runtime with wasm-pack..."
wasm-pack build \
  "$RUST_DIR/runtime" \
  --release \
  --target=web \
  --weak-refs \
  --no-pack

echo "Runtime WASM built at $RUST_DIR/runtime/pkg/"

# Build subagent CLI as a standalone WASI binary.
# This targets wasm32-wasip1 (the standard WASI target) which is compatible with WASIX runtimes.
WASI_TARGET="wasm32-wasip1"

if ! rustup target list --installed | grep -q "$WASI_TARGET"; then
  echo "Adding $WASI_TARGET target..."
  rustup target add "$WASI_TARGET"
fi

echo "Building subagent-cli for $WASI_TARGET..."
cargo build \
  --release \
  --target "$WASI_TARGET" \
  --manifest-path "$RUST_DIR/subagent-cli/Cargo.toml"

# Copy the WASM binary to the assets directory
CLI_WASM="$RUST_DIR/target/$WASI_TARGET/release/subagent.wasm"
if [ -f "$CLI_WASM" ]; then
  cp "$CLI_WASM" "$ASSETS_DIR/subagent.wasm"
  echo "Copied subagent.wasm to $ASSETS_DIR"
else
  echo "Warning: subagent.wasm not found at $CLI_WASM" >&2
fi

echo "Build complete."
echo "  Runtime pkg: $RUST_DIR/runtime/pkg/"
echo "  Assets:      $ASSETS_DIR/"
ls -la "$ASSETS_DIR"
