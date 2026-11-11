#!/usr/bin/env bash
# Matebot fork entrypoint: same installer as upstream, with fork raw URLs and GHCR defaults.
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MATEBOT_DOWNLOAD_BASE="${MATEBOT_DOWNLOAD_BASE:-https://raw.githubusercontent.com/Lizer2009/matebot/main/infra/compose}"
export MATEBOT_ENV_IMAGES_EXAMPLE="${MATEBOT_ENV_IMAGES_EXAMPLE:-.env.images.matebot.example}"
exec bash "$script_dir/install-images.sh" "$@"
