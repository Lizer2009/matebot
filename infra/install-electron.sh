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
#
# Two caches are filled, because two tools download the same runtime separately:
# - the electron package, used by tests and `electron .`
# - @electron/get's cache, which electron-builder reads when it packages an installer
set -eu
package="$(node -p "require.resolve('electron/package.json', { paths: ['apps/desktop'] })")"
dir="$(dirname "$package")"
version="$(node -p "require('$package').version")"

wanted_zip() {
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT) os=win32 ;;
    *) os=linux ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) return 1 ;;
  esac
  echo "$os-$arch"
}

installed() {
  [ -f "$dir/path.txt" ] && [ -d "$dir/dist" ]
}

# Fetches one file with backoff; the caller checks what arrived, so a retry cannot accept a
# different build than the one the release pins.
fetch() {
  url=$1
  dest=$2
  attempt=1
  while :; do
    if curl -fsSL --retry 3 --retry-delay 3 --retry-connrefused "$url" -o "$dest"; then return 0; fi
    if [ "$attempt" -ge 10 ]; then
      echo "could not download $url after $attempt attempts" >&2
      return 1
    fi
    wait_seconds=$((attempt * 15))
    [ "$wait_seconds" -gt 60 ] && wait_seconds=60
    echo "download attempt $attempt failed; retrying in ${wait_seconds}s" >&2
    sleep "$wait_seconds"
    attempt=$((attempt + 1))
  done
}

if ! installed; then
  attempt=1
  while :; do
    # The installer exits 0 even when its download failed, so the presence of the binary is what
    # decides whether this attempt worked.
    node "$dir/install.js" || true
    if installed; then
      echo "Electron installed on attempt $attempt."
      break
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
else
  echo "Electron is already installed."
fi

# electron-builder resolves its own copy through @electron/get, which shares one cache folder and
# downloads without retrying. Seeding that cache means the packaging step never has to reach the
# releases host at all.
cache="${ELECTRON_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/electron}"
if platform="$(wanted_zip)"; then
  zip="$cache/electron-v${version}-${platform}.zip"
  if [ -s "$zip" ]; then
    echo "Electron packaging cache already has $(basename "$zip")."
  else
    mkdir -p "$cache"
    if fetch "https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-${platform}.zip" "$zip.part"; then
      mv "$zip.part" "$zip"
      echo "Electron packaging cache seeded with $(basename "$zip")."
    else
      rm -f "$zip.part"
      echo "Could not seed the Electron packaging cache; electron-builder will try its own download." >&2
    fi
  fi
fi
