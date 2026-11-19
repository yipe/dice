#!/usr/bin/env bash
# Builds the drop-in Rust-backed @yipe/dice package at rust/dice-node/pkg (ESM + CJS + .d.ts + dice.node).
# Pass --rebuild-native to run build.sh first. Run from anywhere.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
[ "${1:-}" = "--rebuild-native" ] && nice -n 10 bash "$here/build.sh"
[ -f "$here/dice.node" ] || { echo "missing dice.node: run build.sh" >&2; exit 1; }
cd "$repo"
node "$here/build-pkg.mjs"
# Declarations: tsc over src (the public API is unchanged), with the .js specifier fix-up.
tmp="$(mktemp -d)"
mkdir -p "$tmp/config"
cp config/postbuild-dts.mjs "$tmp/config/"
nice -n 10 node_modules/.bin/tsc -p config/tsconfig.build.json --emitDeclarationOnly --outDir "$tmp/dist"
node "$tmp/config/postbuild-dts.mjs"
(cd "$tmp/dist" && find . -name '*.d.ts' | while read -r f; do mkdir -p "$here/pkg/dist/$(dirname "$f")"; cp "$f" "$here/pkg/dist/$f"; done)
rm -rf "$tmp"
echo "pkg ready: $here/pkg"
