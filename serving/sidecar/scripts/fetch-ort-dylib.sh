#!/usr/bin/env bash
# Fetch the ONNX Runtime dylib the macOS sidecar loads at runtime.
#
# The `ort` crate's newest release (2.0.0-rc.12) statically links ORT 1.24.2,
# but ORT >= 1.25 executes CoreML conv graphs ~3x faster (measured on M3:
# GapCloser batch-24 ~5s -> 1.26s, AnT bucket forward ~1.9s -> 0.7s). So the
# macOS build uses the crate's `load-dynamic` feature and ships Microsoft's
# official dylib next to the sidecar binary; see src/ort_dylib.rs for how it
# is located at runtime.
#
# Output: serving/sidecar/vendor/libonnxruntime.<version>.dylib (gitignored).
# Packaging copies it from there (app/vue.config.js extraResources).
set -euo pipefail

ORT_VERSION=1.27.0
SHA256=299e5a2c6ea00531ecd6bf3217e23798c1fcba1698bb386d313c8e16d7317d60

cd "$(dirname "$0")/.."
mkdir -p vendor
DYLIB="vendor/libonnxruntime.${ORT_VERSION}.dylib"

# Keep vendor/ holding only the current version. Packaging globs
# libonnxruntime.*.dylib (app/vue.config.js) so the version lives in exactly one
# place — this script — and the runtime picks the lexicographically-greatest
# match (src/ort_dylib.rs); a stale sibling from a previous bump would be shipped
# and could be mis-selected. Prune before the up-to-date short-circuit so it runs
# even when the current dylib is already present.
find vendor -maxdepth 1 -name 'libonnxruntime.*.dylib' ! -name "$(basename "$DYLIB")" -delete

if [ -f "$DYLIB" ] && echo "$SHA256  $DYLIB" | shasum -a 256 -c - >/dev/null 2>&1; then
  echo "$DYLIB already present and verified"
  exit 0
fi

TGZ="$(mktemp -d)/ort.tgz"
URL="https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-osx-arm64-${ORT_VERSION}.tgz"
echo "fetching $URL"
curl -sL -o "$TGZ" "$URL"
tar xzf "$TGZ" -C "$(dirname "$TGZ")" \
  "onnxruntime-osx-arm64-${ORT_VERSION}/lib/libonnxruntime.${ORT_VERSION}.dylib"
cp "$(dirname "$TGZ")/onnxruntime-osx-arm64-${ORT_VERSION}/lib/libonnxruntime.${ORT_VERSION}.dylib" "$DYLIB"

echo "$SHA256  $DYLIB" | shasum -a 256 -c -
echo "fetched $DYLIB"
