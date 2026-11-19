#!/usr/bin/env bash
# Builds rust/dice-node/dice.node (the napi addon). Run from anywhere.
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release
case "$(uname -s)" in
  Darwin) lib=libdice_node.dylib ;;
  Linux) lib=libdice_node.so ;;
  *) lib=dice_node.dll ;;
esac
cp "target/release/$lib" dice.node
echo "built $(pwd)/dice.node"
