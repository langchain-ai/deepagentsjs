#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS_DIR="$SCRIPT_DIR/../assets"
mkdir -p "$ASSETS_DIR"

BASE_URL="https://cdn.wasmer.io/webcimages"

# Asset definitions: name|sha256
ASSETS=(
  "bash.webc|6616eee914dd95cb9751a0ef1d17a908055176781bc0b6090e33da5bbc325417"
  "coreutils.webc|6b2fd4494bd198f60859987608a7633f807a05147e4d8398ec061639d047ce75"
)

sha256_hash() {
  shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1 || sha256sum "$1" 2>/dev/null | cut -d' ' -f1
}

for entry in "${ASSETS[@]}"; do
  name="${entry%%|*}"
  sha="${entry##*|}"
  filepath="$ASSETS_DIR/$name"
  url="$BASE_URL/$sha.webc"

  # Skip if file exists and hash matches
  if [ -f "$filepath" ]; then
    existing_sha=$(sha256_hash "$filepath")
    if [ "$existing_sha" = "$sha" ]; then
      echo "✓ $name (cached)"
      continue
    fi
    echo "⚠ $name exists but hash mismatch, re-downloading..."
  fi

  echo "↓ Downloading $name..."
  curl -fsSL -o "$filepath" "$url"

  # Verify checksum
  dl_sha=$(sha256_hash "$filepath")
  if [ "$dl_sha" != "$sha" ]; then
    rm -f "$filepath"
    echo "✗ $name checksum mismatch (expected $sha, got $dl_sha)" >&2
    exit 1
  fi
  echo "✓ $name downloaded"
done
