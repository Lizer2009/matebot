#!/bin/sh
# Installs the pinned agent-browser release into the given folder, checked against its sha256.
# The computer image, hosted computers and CI's page-browser tests all use it, so they run the
# same binary. A folder that already holds that binary is left as it is.
# The release binaries are byte-identical to the ones in the npm package, which carries
# SLSA provenance; bump the version and both hashes together.
set -eu
dest="${1:?usage: install-agent-browser.sh <folder>}"
version=0.41.0
case "$(uname -m)" in
  x86_64 | amd64) arch=x64; sha256=399c7e9f06bd29aa933fdf25c0bd958eea06927fc0ce6f536ba6347aabd64628 ;;
  aarch64 | arm64) arch=arm64; sha256=e196e9cabe6cb1b01bd5912973628361b9f40a332683a12426abad007f0d3589 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
if echo "$sha256  $dest/agent-browser" | sha256sum -c --status 2>/dev/null; then exit 0; fi
mkdir -p "$dest"
binary="$(mktemp)"
trap 'rm -f "$binary"' EXIT
# The releases host answers 504 intermittently under load. A retry is what turns that into a
# slow install instead of a failed job; the sha256 check below still decides whether the bytes
# are the pinned binary, so a retry can never accept a different one.
url="https://github.com/vercel-labs/agent-browser/releases/download/v${version}/agent-browser-linux-${arch}"
attempt=1
while :; do
  if curl -fsSL --retry 2 --retry-delay 2 --retry-connrefused "$url" -o "$binary"; then break; fi
  if [ "$attempt" -ge 5 ]; then
    echo "could not download $url after $attempt attempts" >&2
    exit 1
  fi
  echo "download attempt $attempt failed; retrying in $((attempt * 5))s" >&2
  sleep $((attempt * 5))
  attempt=$((attempt + 1))
done
echo "$sha256  $binary" | sha256sum -c -
install -m 755 "$binary" "$dest/agent-browser"
"$dest/agent-browser" --version
