#!/bin/sh
# Installs the Electron binary the repository's electron package expects, retrying while the
# releases host refuses the download.
#
# `pnpm install` runs electron's own postinstall, which downloads once and gives up. The host
# answers 504 in bursts lasting minutes, so a job that needs a real Electron binary — the smoke
# tests, the native-computer suites, the installer build — fails for a reason that has nothing
# to do with its code. This retries that one step.
#
# It never changes which binary is installed: electron's own installer still resolves the version,
# its checksum and its cache directory from the installed package.
set -eu
package="$(node -p "require.resolve('electron/package.json', { paths: ['apps/desktop'] })")"
dir="$(dirname "$package")"

if [ -f "$dir/path.txt" ] && [ -d "$dir/dist" ]; then
  echo "Electron is already installed."
  exit 0
fi

attempt=1
while :; do
  # The installer exits 0 even when its download failed, so the presence of the binary is what
  # decides whether this attempt worked.
  node "$dir/install.js" || true
  if [ -f "$dir/path.txt" ] && [ -d "$dir/dist" ]; then
    echo "Electron installed on attempt $attempt."
    exit 0
  fi
  if [ "$attempt" -ge 10 ]; then
    echo "Electron could not be downloaded after $attempt attempts." >&2
    exit 1
  fi
  wait_seconds=$((attempt * 15))
  [ "$wait_seconds" -gt 60 ] && wait_seconds=60
  echo "Electron download attempt $attempt failed; retrying in ${wait_seconds}s" >&2
  sleep "$wait_seconds"
  attempt=$((attempt + 1))
done
