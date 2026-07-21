#!/usr/bin/env bash
# Create (or refresh) the model-artifacts GitHub Release and upload the ONNX
# files, verifying each against app/src/util/model-manifest.js first — the
# release must never drift from what the app pins.
#
# Usage: upload_models_release.sh <models-dir> [owner/repo]
#   <models-dir>  directory holding the canonically named files
#                 (ant_v2_fp32.onnx, ant_v2_fp32_bucket.onnx,
#                  gap_closer_fp32.onnx — symlinks are fine)
#   [owner/repo]  defaults to latentspacelabs/cadmium-oss
#
# Needs: gh (authenticated with repo write), node, shasum.
set -euo pipefail

DIR=${1:?usage: upload_models_release.sh <models-dir> [owner/repo]}
REPO=${2:-latentspacelabs/cadmium-oss}

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
MANIFEST="$SCRIPT_DIR/../../app/src/util/model-manifest.js"

command -v gh >/dev/null || { echo "gh CLI not found" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }

TAG=$(node -e "console.log(require('$MANIFEST').MODELS_RELEASE_TAG)")

# "file sha256 bytes" per line, straight from the manifest.
ENTRIES=$(node -e "
  require('$MANIFEST').MODEL_FILES.forEach(m =>
    console.log(m.file, m.sha256, m.bytes));
")

echo "Verifying files in $DIR against $(basename "$MANIFEST")"
FILES=()
while read -r file sha bytes; do
  path="$DIR/$file"
  [ -e "$path" ] || { echo "MISSING: $path" >&2; exit 1; }
  actual_bytes=$(stat -Lf %z "$path" 2>/dev/null || stat -Lc %s "$path")
  [ "$actual_bytes" = "$bytes" ] || {
    echo "SIZE MISMATCH: $file is $actual_bytes bytes, manifest says $bytes" >&2
    exit 1
  }
  echo "  sha256 $file ($bytes bytes)..."
  actual_sha=$(shasum -a 256 "$path" | awk '{print $1}')
  [ "$actual_sha" = "$sha" ] || {
    echo "SHA256 MISMATCH: $file" >&2
    echo "  manifest: $sha" >&2
    echo "  actual:   $actual_sha" >&2
    exit 1
  }
  FILES+=("$path")
done <<< "$ENTRIES"

if ! gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  echo "Creating release $TAG on $REPO"
  gh release create "$TAG" -R "$REPO" \
    --title "Model artifacts ($TAG)" \
    --notes "ONNX model artifacts for the embedded serving backend. Pinned by app/src/util/model-manifest.js — do not replace assets in place; publish a new tag instead."
fi

echo "Uploading ${#FILES[@]} files to $REPO release $TAG"
gh release upload "$TAG" -R "$REPO" --clobber "${FILES[@]}"
echo "Done."
