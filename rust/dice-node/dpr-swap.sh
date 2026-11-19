#!/usr/bin/env bash
# Usage: dpr-swap.sh ts|rust <dpr-worktree>
# Switches <worktree>/node_modules/@yipe/dice between the published TS dist (kept at
# node_modules/@yipe/dice.ts-dist) and a symlink to rust/dice-node/pkg (the Rust-backed build).
set -euo pipefail
mode="${1:-}"; wt="${2:-}"
[ -n "$wt" ] && [ -d "$wt/node_modules/@yipe" ] || { echo "usage: $0 ts|rust <dpr-worktree>" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$here/pkg"
dir="$wt/node_modules/@yipe"
live="$dir/dice"
aside="$dir/dice.ts-dist"
case "$mode" in
  rust)
    [ -f "$pkg/package.json" ] || { echo "no $pkg: run build-pkg.sh" >&2; exit 1; }
    if [ -L "$live" ]; then :; else
      [ -e "$aside" ] && { echo "refusing: $aside already exists" >&2; exit 1; }
      mv "$live" "$aside"
    fi
    ln -sfn "$pkg" "$live"
    ;;
  ts)
    if [ -L "$live" ]; then
      [ -d "$aside" ] || { echo "missing $aside" >&2; exit 1; }
      rm "$live"; mv "$aside" "$live"
    fi
    ;;
  *) echo "usage: $0 ts|rust <dpr-worktree>" >&2; exit 2 ;;
esac
# probe: a PMF built by the loaded package has a native handle only the Rust facade defines
(cd "$wt" && node --input-type=module -e '
import { PMF } from "@yipe/dice";
const rust = new PMF(new Map([[1, 1]]))._handle !== undefined;
console.log("@yipe/dice engine:", rust ? "rust" : "ts");
process.exit(rust === ('"$([ "$mode" = rust ] && echo true || echo false)"') ? 0 : 1);
')
