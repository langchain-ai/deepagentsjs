#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
RUST_DIR="$PACKAGE_DIR/rust"
OUT_DIR="$PACKAGE_DIR/src/wasm"

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

echo "Building engine crate with wasm-pack..."
wasm-pack build \
  "$RUST_DIR/engine" \
  --target bundler \
  --out-dir "$OUT_DIR" \
  --out-name engine

# wasm-pack generates a .gitignore that blocks committing the output.
# Remove it since we want the wasm output to be version-controlled.
rm -f "$OUT_DIR/.gitignore"

# Build deepagent CLI as a standalone WASI binary.
# This targets wasm32-wasip1 (the standard WASI target) which is compatible with WASIX runtimes.
WASI_TARGET="wasm32-wasip1"

if ! rustup target list --installed | grep -q "$WASI_TARGET"; then
  echo "Adding $WASI_TARGET target..."
  rustup target add "$WASI_TARGET"
fi

echo "Building deepagent-cli for $WASI_TARGET..."
cargo build \
  --release \
  --target "$WASI_TARGET" \
  --manifest-path "$RUST_DIR/deepagent-cli/Cargo.toml"

# Copy the WASM binary to the output directory
CLI_WASM="$RUST_DIR/target/$WASI_TARGET/release/deepagent.wasm"
if [ -f "$CLI_WASM" ]; then
  cp "$CLI_WASM" "$OUT_DIR/deepagent.wasm"
  echo "Copied deepagent.wasm to $OUT_DIR"
else
  echo "Warning: deepagent.wasm not found at $CLI_WASM" >&2
fi

echo "Build complete. Output in $OUT_DIR"
ls -la "$OUT_DIR"
