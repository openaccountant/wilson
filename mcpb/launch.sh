#!/bin/sh
# Claude Desktop extension launcher (macOS / Linux): run the wilson binary that
# matches this machine's CPU. A manifest cannot pick by architecture, and an
# x64 binary under Rosetta cannot load an arm64 Homebrew SQLCipher.
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "wilson: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac
bin="$dir/wilson-$os-$arch"
if [ ! -f "$bin" ]; then
  echo "wilson: this extension has no build for $os-$arch" >&2
  exit 1
fi
# Zip extraction does not always keep the executable bit.
[ -x "$bin" ] || chmod +x "$bin" 2>/dev/null
exec "$bin" "$@"
